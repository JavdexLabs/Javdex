import { afterEach, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { catalogVideoCommands } from './catalogVideoCommands'
import { readVideoAggregateVersion } from './catalogAggregateVersion'

let directory: string | undefined
afterEach(() => {
  closeDatabase()
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
  directory = undefined
  delete process.env.JAVDEX_TEST_USER_DATA
})

function fixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-command-'))
  process.env.JAVDEX_TEST_USER_DATA = directory
  initDatabaseAtPath(path.join(directory, 'library.db'))
  ensureCatalogIdentity()
  const videoId = Number(getDb().prepare("INSERT INTO videos(code,title) VALUES ('ABC-001','before')").run().lastInsertRowid)
  return { videoId, context: { operationId: randomUUID(), writerEpoch: 0, expectedVersions: { V: readVideoAggregateVersion(videoId)! } } }
}

it('edits through one versioned receipt and replays without writing twice', () => {
  const { videoId, context } = fixture()
  const input = { videoId, fields: { title: 'after' } }
  const first = catalogVideoCommands.edit(input, context)
  assert.equal(first.data.ok, true)
  assert.equal(first.outcome, 'applied')
  const replay = catalogVideoCommands.edit(input, context)
  assert.equal(replay.outcome, 'duplicate')
  assert.deepEqual(replay.data, first.data)
  assert.deepEqual(readVideoAggregateVersion(videoId), first.data.versions.V)
  assert.throws(() => catalogVideoCommands.edit({ videoId, fields: { title: 'stale' } }, { ...context, operationId: randomUUID() }),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
})

it('retains unversioned desktop status writes but requires server versions', () => {
  const { videoId } = fixture()
  const context = { operationId: randomUUID(), writerEpoch: 0, expectedVersions: {} }
  assert.throws(() => catalogVideoCommands.markScrapeSuccess({ videoId }, context),
    (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
  assert.equal(catalogVideoCommands.markScrapeSuccess({ videoId }, { ...context, operationId: randomUUID() }, true).data.ok, true)
})

it('legacy desktop calls still reject a supplied stale version', () => {
  const { videoId, context } = fixture()
  catalogVideoCommands.setRating({ videoId, rating: 4 }, context)
  assert.throws(() => catalogVideoCommands.clearMeta({ videoId }, { ...context, operationId: randomUUID() }, true),
    (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
})
