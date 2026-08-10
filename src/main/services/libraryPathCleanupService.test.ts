import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertScannedVideo } from '../db/videoRepo'
import { getSettings, resetSettingsCacheForTests, updateSettings } from '../settings/settingsStore'
import {
  confirmLibraryPathRemoval,
  consumePendingLibraryPathCleanups,
  previewLibraryPathRemoval
} from './libraryPathCleanupService'

let tempRoot = ''
let libraryRoot = ''
let otherRoot = ''
let previousUserData: string | undefined

function createLocalVideo(code: string, filePath: string): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, code)
  const videoId = insertScannedVideo({
    code,
    locator: filePath,
    size_bytes: code.length
  })
  assert.ok(videoId)
  return videoId
}

function insertWebResource(videoId: number, locator: string): void {
  getDb()
    .prepare(
      `INSERT INTO video_resources
         (video_id, kind, locator, resource_key, is_primary, add_time)
       VALUES (?, 'web', ?, ?, 0, ?)`
    )
    .run(videoId, locator, `web:${locator}`, '2026-08-10T00:00:00.000Z')
}

beforeEach(() => {
  previousUserData = process.env.JAVDEX_TEST_USER_DATA
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-path-cleanup-'))
  libraryRoot = path.join(tempRoot, 'library')
  otherRoot = path.join(tempRoot, 'other')
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  resetSettingsCacheForTests()
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
})

afterEach(() => {
  closeDatabase()
  resetSettingsCacheForTests()
  if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
  else process.env.JAVDEX_TEST_USER_DATA = previousUserData
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('libraryPathCleanupService', () => {
  it('previews affected local resources and only videos that would lose every resource', () => {
    updateSettings({ libraryPaths: [libraryRoot] })
    createLocalVideo('ONLY-001', path.join(libraryRoot, 'only.mp4'))
    const linkedVideoId = createLocalVideo('LINK-001', path.join(libraryRoot, 'linked.mp4'))
    insertWebResource(linkedVideoId, 'https://example.test/watch/link-001')
    const multiLocalVideoId = createLocalVideo('MULTI-001', path.join(libraryRoot, 'multi.mp4'))
    getDb()
      .prepare(
        `INSERT INTO video_resources
           (video_id, kind, locator, resource_key, is_primary, add_time)
         VALUES (?, 'local', ?, ?, 0, ?)`
      )
      .run(
        multiLocalVideoId,
        path.join(otherRoot, 'multi-copy.mp4'),
        `local:${path.join(otherRoot, 'multi-copy.mp4')}`,
        '2026-08-10T00:00:00.000Z'
      )

    assert.deepEqual(previewLibraryPathRemoval(libraryRoot), {
      path: libraryRoot,
      localResourceCount: 3,
      videosBecomingResourceLess: 1
    })
  })

  it('removes the configured path and persists cleanup without touching resources or files', () => {
    const filePath = path.join(libraryRoot, 'queued.mp4')
    const videoId = createLocalVideo('QUEUE-001', filePath)
    updateSettings({ libraryPaths: [libraryRoot, otherRoot] })

    const next = confirmLibraryPathRemoval(libraryRoot)

    assert.deepEqual(next.libraryPaths, [otherRoot])
    assert.deepEqual(next.pendingLibraryPathCleanups, [libraryRoot])
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS n FROM video_resources').get() as { n: number }).n,
      1
    )
    assert.equal(fs.existsSync(filePath), true)

    resetSettingsCacheForTests()
    assert.deepEqual(getSettings().pendingLibraryPathCleanups, [libraryRoot])
    assert.equal(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS n FROM video_resources WHERE video_id = ?')
          .get(videoId) as { n: number }
      ).n,
      1
    )
  })

  it('consumes queued roots in one cleanup while retaining videos and original files', () => {
    const onlyPath = path.join(libraryRoot, 'only.mp4')
    const onlyVideoId = createLocalVideo('ONLY-002', onlyPath)
    const linkedPath = path.join(libraryRoot, 'linked.mp4')
    const linkedVideoId = createLocalVideo('LINK-002', linkedPath)
    insertWebResource(linkedVideoId, 'https://example.test/watch/link-002')
    const outsidePath = path.join(otherRoot, 'multi-copy.mp4')
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true })
    fs.writeFileSync(outsidePath, 'copy')
    const multiVideoId = createLocalVideo('MULTI-002', path.join(libraryRoot, 'multi.mp4'))
    getDb()
      .prepare(
        `INSERT INTO video_resources
           (video_id, kind, locator, resource_key, is_primary, add_time)
         VALUES (?, 'local', ?, ?, 0, ?)`
      )
      .run(
        multiVideoId,
        outsidePath,
        `local:${outsidePath}`,
        '2026-08-10T00:00:00.000Z'
      )
    updateSettings({
      libraryPaths: [otherRoot],
      pendingLibraryPathCleanups: [libraryRoot]
    })

    const result = consumePendingLibraryPathCleanups()

    assert.deepEqual(result, { removed: 3, promoted: 2, consumedRoots: [libraryRoot] })
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n,
      3
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS n FROM video_resources WHERE video_id = ?')
          .get(onlyVideoId) as { n: number }
      ).n,
      0
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT kind FROM video_resources WHERE video_id = ?')
          .get(linkedVideoId) as { kind: string }
      ).kind,
      'web'
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT locator FROM video_resources WHERE video_id = ?')
          .get(multiVideoId) as { locator: string }
      ).locator,
      outsidePath
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT is_primary FROM video_resources WHERE video_id = ?')
          .get(linkedVideoId) as { is_primary: number }
      ).is_primary,
      1
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT is_primary FROM video_resources WHERE video_id = ?')
          .get(multiVideoId) as { is_primary: number }
      ).is_primary,
      1
    )
    assert.deepEqual(getSettings().pendingLibraryPathCleanups, [])
    assert.equal(fs.existsSync(onlyPath), true)
    assert.equal(fs.existsSync(linkedPath), true)
  })
})
