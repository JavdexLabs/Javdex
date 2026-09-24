import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { createMediaLibrary } from '@library/db/mediaLibraryRepo'
import {
  getPendingResourceIdentityRecord,
  upsertPendingResourceIdentity
} from '@library/db/pendingResourceIdentityRepo'
import { listVideos, listVideoResources } from '@library/db/videoRepo'
import type { LocalNfoScanService } from './nfoScanPort'
import { resolvePendingResourceIdentity } from './pendingResourceIdentityService'

let temporaryDirectory: string | null = null

afterEach(() => {
  closeDatabase()
  if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

function setup() {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-nfo-identity-resolve-'))
  initDatabaseAtPath(path.join(temporaryDirectory, 'library.db'))
  const rootPath = path.join(temporaryDirectory, 'media')
  fs.mkdirSync(rootPath)
  const library = createMediaLibrary({ name: 'NFO identity', roots: [{ path: rootPath }] })
  return { libraryId: library.id, rootId: library.roots[0].id, rootPath }
}

function localConflict(library: ReturnType<typeof setup>, fileName = 'FILE-001.mp4') {
  const filePath = path.join(library.rootPath, fileName)
  fs.writeFileSync(filePath, 'video')
  const stat = fs.statSync(filePath)
  const identity = upsertPendingResourceIdentity({
    ...library,
    filePath,
    sourceKind: 'local',
    filenameCode: 'FILE-001',
    nfoCode: 'NFO-002',
    sizeBytes: stat.size,
    fileMtimeMs: Math.round(stat.mtimeMs)
  })
  return { filePath, identity }
}

function fakeNfoService(code: string | null, applied: number[]): LocalNfoScanService {
  return {
    inspectIdentity: () =>
      code
        ? { status: 'found', code, warnings: [] }
        : { status: 'missing', code: null, warnings: [] },
    apply: async (videoId) => {
      applied.push(videoId)
      return { disposition: 'imported', warnings: [] }
    }
  }
}

describe('pending resource identity service', () => {
  it('uses the persisted choice, assigns the resource atomically, and applies only a matching current NFO', async () => {
    const library = setup()
    const pending = localConflict(library)
    const applied: number[] = []

    const result = await resolvePendingResourceIdentity(
      library.libraryId,
      pending.identity.id,
      { expectedRevision: pending.identity.revision, choice: 'nfo' },
      {
        readDurationSeconds: async () => 3600,
        nfoService: fakeNfoService('NFO-002', applied)
      }
    )

    assert.equal(result.status, 'assigned')
    assert.equal(result.warnings.length, 0)
    assert.deepEqual(applied, [result.videoId])
    assert.equal(getPendingResourceIdentityRecord(library.libraryId, pending.identity.id), null)
    const video = listVideos({ search: 'NFO-002' }).items[0]
    assert.equal(video.id, result.videoId)
    assert.equal(listVideoResources(library.libraryId, video.id)[0]?.locator, pending.filePath)
  })

  it('completes resource ownership but does not apply metadata when the current NFO no longer matches', async () => {
    const library = setup()
    const pending = localConflict(library)
    const applied: number[] = []

    const result = await resolvePendingResourceIdentity(
      library.libraryId,
      pending.identity.id,
      { expectedRevision: pending.identity.revision, choice: 'filename' },
      {
        readDurationSeconds: async () => null,
        nfoService: fakeNfoService('NFO-002', applied)
      }
    )

    assert.equal(result.status, 'assigned')
    assert.equal(listVideos({ search: 'FILE-001' }).total, 1)
    assert.deepEqual(applied, [])
    assert.match(result.warnings.at(-1) ?? '', /未应用 NFO 元数据/u)
  })

  it('finishes resource ownership when the current NFO cannot be inspected safely', async () => {
    const library = setup()
    const pending = localConflict(library)

    const result = await resolvePendingResourceIdentity(
      library.libraryId,
      pending.identity.id,
      { expectedRevision: pending.identity.revision, choice: 'filename' },
      {
        readDurationSeconds: async () => null,
        nfoService: {
          inspectIdentity: () => {
            throw new Error(`unsafe path: ${pending.filePath}`)
          },
          apply: async () => {
            throw new Error('must not apply')
          }
        }
      }
    )

    assert.equal(result.status, 'assigned')
    assert.equal(listVideos({ search: 'FILE-001' }).total, 1)
    assert.ok(result.warnings.some((warning) => warning.includes('无法安全读取')))
    assert.ok(result.warnings.every((warning) => !warning.includes(pending.filePath)))
  })

  it('keeps the identity pending and creates no formal record when the source fingerprint is stale', async () => {
    const library = setup()
    const pending = localConflict(library)
    fs.writeFileSync(pending.filePath, 'changed video bytes')

    await assert.rejects(
      resolvePendingResourceIdentity(
        library.libraryId,
        pending.identity.id,
        { expectedRevision: pending.identity.revision, choice: 'nfo' },
        { readDurationSeconds: async () => null, nfoService: fakeNfoService('NFO-002', []) }
      ),
      /源文件已发生变化/u
    )
    assert.ok(getPendingResourceIdentityRecord(library.libraryId, pending.identity.id))
    assert.equal(listVideos({}).total, 0)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number })
        .count,
      0
    )
  })

  it('rechecks a STRM target snapshot and leaves the conflict intact when it changes', async () => {
    const library = setup()
    const filePath = path.join(library.rootPath, 'FILE-001.strm')
    const original = 'https://example.test/first.mp4'
    fs.writeFileSync(filePath, original)
    const stat = fs.statSync(filePath)
    const identity = upsertPendingResourceIdentity({
      ...library,
      filePath,
      sourceKind: 'strm',
      targetKind: 'web',
      targetLocator: original,
      targetKey: `http:${original}`,
      filenameCode: 'FILE-001',
      nfoCode: 'NFO-002',
      sizeBytes: stat.size,
      fileMtimeMs: Math.round(stat.mtimeMs)
    })
    const changed = 'https://example.test/other.mp4'
    fs.writeFileSync(filePath, changed.padEnd(original.length, ' '))
    const changedStat = fs.statSync(filePath)
    getDb()
      .prepare('UPDATE pending_resource_identities SET size_bytes = ?, file_mtime_ms = ? WHERE id = ?')
      .run(changedStat.size, Math.round(changedStat.mtimeMs), identity.id)

    await assert.rejects(
      resolvePendingResourceIdentity(
        library.libraryId,
        identity.id,
        { expectedRevision: identity.revision, choice: 'filename' },
        { nfoService: fakeNfoService(null, []) }
      ),
      /STRM 目标已发生变化/u
    )
    assert.ok(getPendingResourceIdentityRecord(library.libraryId, identity.id))
    assert.equal(listVideos({}).total, 0)
  })
})
