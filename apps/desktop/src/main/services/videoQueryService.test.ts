import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { createVideoQueryService, createAsyncVideoQueryService } from './videoQueryService'
import { scopedVideoCatalogRepo } from '@library/db/scopedVideoCatalogRepo'
import { projectVideoDetail } from '@library/catalog/videoDetailProjection'
import { buildVideoResourceSourceIdentity } from '@library/videoResourceIdentity'

const DEFAULT_SCOPE = { kind: 'library', libraryId: 1 } as const

let tempRoot: string | null = null

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(): { videoPath: string; imagePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-query-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  const videoPath = path.join(tempRoot, 'APP-001.mp4')
  const imagePath = path.join(tempRoot, 'image.png')
  fs.writeFileSync(videoPath, 'video')
  fs.writeFileSync(imagePath, PNG_1X1)
  const db = initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  insertTestVideoWithFile(db, {
    code: 'APP-001',
    filePath: videoPath,
    title: 'Application boundary',
    scrapedStatus: 1
  })
  return { videoPath, imagePath }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('VideoQueryService', () => {
  it('lists videos and reads their detail without mutating library state', () => {
    const { videoPath, imagePath } = setupDb()
    const videos = createVideoQueryService()
    const db = getDb()
    const rowsBefore = db.prepare('SELECT * FROM videos WHERE id = 1').all()
    const resourcesBefore = db
      .prepare('SELECT * FROM video_resources WHERE video_id = 1 ORDER BY id')
      .all()
    const changesBefore = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const videoBefore = fs.readFileSync(videoPath)
    const imageBefore = fs.readFileSync(imagePath)
    const videoModifiedBefore = fs.statSync(videoPath).mtimeMs
    const imageModifiedBefore = fs.statSync(imagePath).mtimeMs

    assert.deepEqual(
      videos.list(DEFAULT_SCOPE, { search: 'APP-001' }).items.map((item) => item.code),
      ['APP-001']
    )
    const detail = videos.get(DEFAULT_SCOPE, 1)
    assert.equal(detail?.title, 'Application boundary')
    assert.equal(detail?.resources.length, 1)
    assert.equal(detail?.resources[0]?.kind, 'local')
    assert.equal(detail ? 'files' in detail : true, false)
    assert.deepEqual(db.prepare('SELECT * FROM videos WHERE id = 1').all(), rowsBefore)
    assert.deepEqual(
      db.prepare('SELECT * FROM video_resources WHERE video_id = 1 ORDER BY id').all(),
      resourcesBefore
    )
    assert.equal(
      (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
      changesBefore
    )
    assert.deepEqual(fs.readFileSync(videoPath), videoBefore)
    assert.deepEqual(fs.readFileSync(imagePath), imageBefore)
    assert.equal(fs.statSync(videoPath).mtimeMs, videoModifiedBefore)
    assert.equal(fs.statSync(imagePath).mtimeMs, imageModifiedBefore)
  })

  it('shares the detail contract across host path policies without mutating stored resources', () => {
    const { videoPath } = setupDb()
    const db = getDb()
    db.prepare('UPDATE video_resources SET duration_seconds = 123 WHERE video_id = 1').run()
    const stored = scopedVideoCatalogRepo.get(DEFAULT_SCOPE, 1)!
    const before = structuredClone(stored)
    const local = createVideoQueryService().get(DEFAULT_SCOPE, 1)!
    const remote = projectVideoDetail(stored, {
      projectResource: resource => ({ ...resource, locator: path.basename(resource.locator) })
    })
    assert.equal(local.resources[0].display_locator, videoPath)
    assert.equal(remote.resources[0].display_locator, 'APP-001.mp4')
    assert.equal(local.resolved_duration_seconds, 123)
    assert.deepEqual(remote, {
      ...local,
      resources: local.resources.map(resource => ({ ...resource, display_locator: 'APP-001.mp4' }))
    })
    assert.deepEqual(stored, before)
    for (const resource of [...local.resources, ...remote.resources]) {
      for (const key of ['locator', 'resource_key', 'source_identity']) assert.equal(key in resource, false)
    }
  })

  it('uses metadata duration before primary duration and handles memberless resource-free detail', () => {
    setupDb()
    const stored = scopedVideoCatalogRepo.get(DEFAULT_SCOPE, 1)!
    const primary = { ...stored.resources[0], is_primary: 1, duration_seconds: 123 }
    const secondary = { ...primary, id: primary.id + 1, is_primary: 0, duration_seconds: 999 }
    assert.equal(projectVideoDetail({ ...stored, duration_seconds: 456, resources: [secondary, primary] }).resolved_duration_seconds, 456)
    assert.equal(projectVideoDetail({ ...stored, duration_seconds: null, resources: [secondary, primary] }).resolved_duration_seconds, 123)
    const memberless = projectVideoDetail({ ...stored, activeLibraryId: 0, libraries: [], resources: [], duration_seconds: null })
    assert.equal(memberless.resolved_duration_seconds, null)
    assert.deepEqual(memberless.resources, [])
    assert.equal(memberless.activeLibraryId, 0)
  })

  it('redacts external resource locators in detail projections until explicitly requested', () => {
    setupDb()
    const db = getDb()
    const locator = 'https://cdn.example/APP-001.mp4?token=secret'
    const resourceId = Number(
      db
        .prepare(
          `INSERT INTO video_resources
             (library_id, video_id, kind, locator, resource_key, is_primary)
           VALUES (1, 1, 'direct', ?, ?, 0)`
        )
        .run(locator, `http:${locator}`).lastInsertRowid
    )
    const videos = createVideoQueryService()

    const projected = videos
      .get(DEFAULT_SCOPE, 1)
      ?.resources.find((resource) => resource.id === resourceId)

    assert.ok(projected)
    assert.equal(projected.display_locator, 'cdn.example / APP-001.mp4')
    assert.equal('locator' in projected, false)
    assert.equal('resource_key' in projected, false)
    assert.equal(videos.getResource(1, 1, resourceId)?.locator, locator)
    assert.equal(videos.getResource(2, 1, resourceId), null)
  })

  it('projects a STRM source path while keeping its complete target main-process only', () => {
    setupDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'APP-001.strm')
    const locator = 'https://cdn.example/APP-001.mp4?token=strm-secret'
    const resourceId = Number(
      db
        .prepare(
          `INSERT INTO video_resources
             (library_id, video_id, kind, locator, resource_key, source_identity,
              strm_source_path, is_primary)
           VALUES (1, 1, 'direct', ?, ?, ?, ?, 0)`
        )
        .run(
          locator,
          `strm:${sourcePath}`,
          buildVideoResourceSourceIdentity({
            kind: 'direct',
            locator,
            strmSourcePath: sourcePath
          }),
          sourcePath
        ).lastInsertRowid
    )
    const videos = createVideoQueryService()

    const projected = videos
      .get(DEFAULT_SCOPE, 1)
      ?.resources.find((resource) => resource.id === resourceId)

    assert.ok(projected)
    assert.equal(projected.strm_source_path, sourcePath)
    assert.equal(projected.display_locator, 'cdn.example / APP-001.mp4')
    assert.equal('locator' in projected, false)
    assert.equal(videos.getResource(1, 1, resourceId)?.locator, locator)
  })
})


it('keeps worker failures explicit while detail and resource reads remain local', async t => {
  setupDb()
  const local = createVideoQueryService()
  const expected = local.get(DEFAULT_SCOPE, 1)
  const resourceId = expected!.resources[0].id
  t.mock.method(local, 'list', () => { throw new Error('sync fallback forbidden') })
  t.mock.method(local, 'listYears', () => { throw new Error('sync fallback forbidden') })
  const failure = new Error('worker unavailable')
  const service = createAsyncVideoQueryService({
    readVideos: async () => { throw failure },
    readVideoYears: async () => { throw failure }
  }, local)
  await assert.rejects(service.list(DEFAULT_SCOPE), error => error === failure)
  await assert.rejects(service.listYears(DEFAULT_SCOPE), error => error === failure)
  assert.deepEqual(service.get(DEFAULT_SCOPE, 1), expected)
  assert.equal(service.getResource(1, 1, resourceId)?.id, resourceId)
})
