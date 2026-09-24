import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { getPendingVideoScrapeForVideo } from '@library/db/pendingVideoScrapeRepo'
import { normalizeActressName } from '@library/db/actressNameNormalization'
import { getActressDetail } from '@library/db/actressRepo'
import { isStructuredError } from '@shared/protocol/errors'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { ensureCatalogIdentity } from './catalogIdentity'
import { readOperationReceipt, type CatalogWriteContext } from './catalogOperations'
import { readActressAggregateVersion, readVideoAggregateVersion } from './catalogAggregateVersion'
import {
  applyActressScrapeCommand,
  applyVideoScrapeCommand,
  confirmPendingVideoScrapeCommand,
  replacePendingVideoScrapeCommand,
  submitActressScrapeConflictCommand
} from './catalogScrapeCommands'

let root: string | undefined
const previousUserData = process.env.JAVDEX_TEST_USER_DATA

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
})

function setup(server: boolean) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-scrape-commands-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  const database = initDatabaseAtPath(path.join(root, 'library.db'))
  ensureCatalogIdentity({ catalogId: randomUUID(), serverId: server ? randomUUID() : null })
  const writerEpoch = server ? 7 : 0
  database.prepare('UPDATE catalog_identity SET writer_epoch = ? WHERE id = 1').run(writerEpoch)
  // Local adapters omit database; server handlers pass their authoritative connection.
  return (expectedVersions: ExpectedVersions): CatalogWriteContext => ({
    operationId: randomUUID(), expectedVersions, writerEpoch,
    ...(server ? { database } : {})
  })
}

function insertVideo(): number {
  return Number(getDb().prepare("INSERT INTO videos(code, title) VALUES ('CMD-001', 'Original')").run().lastInsertRowid)
}

function title(videoId: number): string {
  return (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string }).title
}

function insertActress(name: string): number {
  const db = getDb()
  const id = Number(db.prepare('INSERT INTO actresses(main_name) VALUES (?)').run(name).lastInsertRowid)
  db.prepare("INSERT INTO actress_names(actress_id, name, type, is_primary) VALUES (?, ?, 'main', 1)").run(id, name)
  db.prepare('INSERT INTO actress_name_ownership(normalized_name, actress_id) VALUES (?, ?)').run(normalizeActressName(name), id)
  return id
}

function pendingFixture(context: ReturnType<typeof setup>) {
  const videoId = insertVideo()
  const input: Parameters<typeof replacePendingVideoScrapeCommand>[0] = {
    videoId, selectedFields: ['title'], applicableFields: ['title'], updateMode: 'replace',
    sources: [{
      pluginName: 'Test', pluginSource: 'builtin', sourceName: 'Test', selectedFields: ['title'],
      candidates: [{ result: { code: 'CMD-001', title: 'Confirmed' } }]
    }]
  }
  const write = context({ V: readVideoAggregateVersion(videoId)! })
  const replaced = replacePendingVideoScrapeCommand(input, write)
  const pending = getPendingVideoScrapeForVideo(videoId)!
  assert.equal(pending.id, replaced.data.pendingScrapeId)
  return {
    videoId, input, write, replaced, pending,
    confirmation: {
      pendingScrapeId: pending.id,
      selections: pending.sources.map((source) => ({ sourceId: source.id, candidateId: source.candidates[0].id }))
    }
  }
}

const versionConflict = (error: unknown): boolean => isStructuredError(error) && error.code === 'VERSION_CONFLICT'

for (const server of [false, true]) {
  describe(`shared scrape commands with ${server ? 'server' : 'local'} write context`, () => {
    it('replays pending replacement and confirmation after confirmation removes the pending row', () => {
      const context = setup(server)
      const { videoId, input, write, replaced, confirmation } = pendingFixture(context)
      const replaceReplay = replacePendingVideoScrapeCommand(input, write)
      assert.equal(replaceReplay.outcome, 'duplicate')
      assert.deepEqual(replaceReplay.data, replaced.data)
      const confirmContext = context(replaced.data.versions)
      const confirmed = confirmPendingVideoScrapeCommand(confirmation, confirmContext)
      assert.equal(confirmed.outcome, 'applied')
      assert.equal(confirmed.data.status, 'applied')
      assert.equal(confirmed.data.applied, true)
      assert.equal(title(videoId), 'Confirmed')
      assert.equal(getPendingVideoScrapeForVideo(videoId), null)
      const versionAfter = readVideoAggregateVersion(videoId)!
      assert.ok(versionAfter.revision > replaced.data.versions.V.revision)
      assert.deepEqual(confirmed.data.versions.V, versionAfter)

      const replay = confirmPendingVideoScrapeCommand(confirmation, confirmContext)
      assert.equal(replay.outcome, 'duplicate')
      assert.deepEqual(replay.data, confirmed.data)
      assert.equal(replay.receipt.operationId, confirmed.receipt.operationId)
      assert.equal(replay.receipt.digest, confirmed.receipt.digest)
      assert.deepEqual(readVideoAggregateVersion(videoId), versionAfter)
      assert.equal(getPendingVideoScrapeForVideo(videoId), null)
      assert.equal(readOperationReceipt(confirmContext.operationId)?.status, 'applied')
      const receipt = getDb().prepare('SELECT writer_epoch FROM catalog_operation_receipts WHERE operation_id = ?')
        .get(confirmContext.operationId) as { writer_epoch: number }
      assert.equal(receipt.writer_epoch, confirmContext.writerEpoch)

      const newRequest = context(replaced.data.versions)
      assert.throws(() => confirmPendingVideoScrapeCommand(confirmation, newRequest),
        (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
      assert.equal(readOperationReceipt(newRequest.operationId), null)
    })

    it('rejects stale V and Q and missing Q without consuming pending confirmation', () => {
      const context = setup(server)
      const { videoId, pending, replaced, confirmation } = pendingFixture(context)
      const versions = replaced.data.versions
      for (const expected of [
        { ...versions, V: { ...versions.V, revision: versions.V.revision - 1 } },
        { ...versions, Q: { ...versions.Q, revision: versions.Q.revision - 1 } },
        { V: versions.V }
      ]) {
        const write = context(expected)
        assert.throws(() => confirmPendingVideoScrapeCommand(confirmation, write),
          (error: unknown) => {
            if (expected.V.revision !== versions.V.revision) return versionConflict(error)
            if (!('Q' in expected)) return isStructuredError(error) && error.code === 'INVALID_INPUT'
            // The existing pending resolver reports stale Q as a domain Error.
            return error instanceof Error && error.message.includes('待确认刮削结果已变化')
          })
        assert.equal(title(videoId), 'Original')
        assert.deepEqual(getPendingVideoScrapeForVideo(videoId), pending)
        assert.deepEqual(readVideoAggregateVersion(videoId), versions.V)
        assert.equal(readOperationReceipt(write.operationId), null)
      }
      assert.equal(confirmPendingVideoScrapeCommand(confirmation, context(versions)).data.applied, true)
    })

    it('applies video metadata once, replays despite stale V, and rejects a fresh stale request', () => {
      const context = setup(server)
      const videoId = insertVideo()
      const input: Parameters<typeof applyVideoScrapeCommand>[0] = {
        videoId, fields: ['title'], mode: 'replace', candidate: { code: 'CMD-001', title: 'Applied' }
      }
      const expected = { V: readVideoAggregateVersion(videoId)! }
      const write = context(expected)
      const first = applyVideoScrapeCommand(input, write)
      assert.equal(first.outcome, 'applied')
      assert.equal(first.data.applied, true)
      assert.equal(title(videoId), 'Applied')
      assert.ok(first.data.versions.V.revision > expected.V.revision)
      const replay = applyVideoScrapeCommand(input, write)
      assert.equal(replay.outcome, 'duplicate')
      // Durable receipts use JSON, which omits optional undefined properties.
      assert.deepEqual(replay.data, JSON.parse(JSON.stringify(first.data)))
      const stale = context(expected)
      assert.throws(() => applyVideoScrapeCommand({ ...input, candidate: { code: 'CMD-001', title: 'Stale' } }, stale), versionConflict)
      assert.equal(readOperationReceipt(stale.operationId), null)
      assert.equal(title(videoId), 'Applied')
      assert.deepEqual(readVideoAggregateVersion(videoId), first.data.versions.V)
    })

    it('applies actress metadata and submits a conflict once, rejecting stale A', () => {
      const context = setup(server)
      const actressId = insertActress('Command One')
      insertActress('Command Two')
      const original = { A: readActressAggregateVersion(actressId)! }
      const input: Parameters<typeof applyActressScrapeCommand>[0] = {
        actressId, candidate: { nameZh: '中文名' }, fields: ['nameZh'], mode: 'replace'
      }
      const write = context(original)
      const first = applyActressScrapeCommand(input, write)
      assert.equal(first.data.applied, true)
      assert.equal(getActressDetail(actressId)?.name_zh, '中文名')
      assert.ok(first.data.versions.A.revision > original.A.revision)
      const replay = applyActressScrapeCommand(input, write)
      assert.equal(replay.outcome, 'duplicate')
      assert.deepEqual(replay.data, first.data)
      const staleApply = context(original)
      assert.throws(() => applyActressScrapeCommand(input, staleApply), versionConflict)
      assert.equal(readOperationReceipt(staleApply.operationId), null)

      const conflict: Parameters<typeof submitActressScrapeConflictCommand>[0] = {
        actressId, pluginName: 'Test', pluginSource: 'builtin', queryName: 'Command One',
        selectedFields: ['aliases'], applicableFields: ['aliases'], mode: 'replace',
        candidate: { aliases: ['Command Two'] }
      }
      const staleSubmit = context(original)
      assert.throws(() => submitActressScrapeConflictCommand(conflict, staleSubmit), versionConflict)
      assert.equal(readOperationReceipt(staleSubmit.operationId), null)
      const submitContext = context(first.data.versions)
      const submitted = submitActressScrapeConflictCommand(conflict, submitContext)
      assert.equal(submitted.outcome, 'applied')
      assert.ok(submitted.data.pendingId > 0)
      const duplicate = submitActressScrapeConflictCommand(conflict, submitContext)
      assert.equal(duplicate.outcome, 'duplicate')
      assert.deepEqual(duplicate.data, submitted.data)
      const rows = getDb().prepare('SELECT id, actress_id FROM pending_actress_scrapes').all()
      assert.deepEqual(rows, [{ id: submitted.data.pendingId, actress_id: actressId }])
      assert.equal(getActressDetail(actressId)?.name_zh, '中文名')
    })
  })
}
