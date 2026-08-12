import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '../db/database'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { createVideoMaintenanceService } from './videoMaintenanceService'
import { createVideoQueryService } from './videoQueryService'
import { classificationQueryService } from './classificationQueryService'
import { recoverPendingLocalFileDeletions } from './pendingLocalFileDeletionService'

let tempRoot: string | null = null

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

function setupDb(prefix = 'javdex-video-maintenance-'): { videoPath: string; imagePath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
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

function setupPolicyDb(): { root: string; videoPath: string } {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-video-maintenance-policy-'))
  process.env.JAVDEX_TEST_USER_DATA = tempRoot
  const videoPath = path.join(tempRoot, 'IPX-535.mp4')
  fs.writeFileSync(videoPath, 'video')
  initDatabaseAtPath(path.join(tempRoot, 'library.db'))
  const db = getDb()
  insertTestVideoWithFile(db, {
    code: 'IPX-535',
    filePath: videoPath,
    title: 'Title',
    summary: 'Summary',
    rating: 4,
    releaseDate: '2024-01-01',
    maker: 'Maker',
    series: 'Series',
    director: 'Director',
    scrapedStatus: 1
  })
  return { root: tempRoot, videoPath }
}

afterEach(() => {
  closeDatabase()
  delete process.env.JAVDEX_TEST_USER_DATA
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('VideoMaintenanceService', () => {
  it('creates and reuses organization identities while editing video metadata', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    videos.edit(1, {
      title: 'With organization',
      makerOrganization: { createName: 'Studio One' },
      publisherOrganization: { createName: 'Ｓtudio　Ｏne' },
      directorAssignment: { createName: 'Alex Lee' },
      seriesAssignment: { createName: 'Collection' }
    })

    const video = query.get(1)
    assert.equal(video?.maker, 'Studio One')
    assert.equal(video?.publisher, 'Studio One')
    assert.ok(video?.maker_organization_id)
    assert.equal(video?.publisher_organization_id, video?.maker_organization_id)
    assert.equal(video?.director, 'Alex Lee')
    assert.ok(video?.director_id)
    assert.equal(video?.series, 'Collection')
    assert.ok(video?.series_id)
    assert.deepEqual(
      classificationQueryService.listOrganizationOptions().map((option) => ({
        id: option.id,
        name: option.mainName,
        roles: option.roles
      })),
      [
        {
          id: video?.maker_organization_id,
          name: 'Studio One',
          roles: ['maker', 'publisher']
        }
      ]
    )
  })

  it('rolls back video fields when organization assignment fails', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    assert.throws(
      () =>
        videos.edit(1, {
          title: 'Must not persist',
          makerOrganization: { createName: '   ' }
        }),
      /分类名称不能为空/
    )

    assert.equal(query.get(1)?.title, 'Application boundary')
    assert.equal(query.get(1)?.maker_organization_id, null)
  })

  it('creates or appends HTTP resources without scraping and keeps one primary resource', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    const appended = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://cdn.example/APP-001.mp4?token=one',
      kind: 'direct',
      displayName: 'Remote copy',
      sizeBytes: 1024
    })
    const created = videos.importLinkResource({
      code: 'NEW-002',
      target: { kind: 'new' },
      url: 'https://example.com/watch?id=2',
      kind: 'web'
    })

    assert.equal(appended.createdVideo, false)
    assert.equal(appended.resource.is_primary, 0)
    assert.equal(created.createdVideo, true)
    assert.equal(created.resource.is_primary, 1)
    assert.equal(query.get(created.videoId)?.scraped_status, 0)
    assert.deepEqual(
      query.get(1)?.resources.map((resource) => [resource.kind, resource.display_name]),
      [
        ['local', null],
        ['direct', 'Remote copy']
      ]
    )
  })

  it('normalizes a manually entered code before attaching a resource', () => {
    setupDb()
    const videos = createVideoMaintenanceService()

    const result = videos.importLinkResource({
      code: ' app-001 ',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch/app-001'
    })

    assert.equal(result.createdVideo, false)
    assert.equal(result.videoId, 1)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }).count,
      1
    )
  })

  it('attaches a normalized link to an existing legacy lowercase code', () => {
    setupDb()
    getDb().prepare("UPDATE videos SET code = 'app-001' WHERE id = 1").run()
    const videos = createVideoMaintenanceService()

    const result = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch/legacy'
    })

    assert.equal(result.createdVideo, false)
    assert.equal(result.videoId, 1)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM videos').get() as { count: number }).count,
      1
    )
  })

  it('reports the owning video when a normalized HTTP resource already exists', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://EXAMPLE.com:443/watch?a=1#first',
      kind: 'web'
    })

    assert.throws(
      () =>
        videos.importLinkResource({
          code: 'OTHER-002',
      target: { kind: 'new' },
          url: 'https://example.com/watch?a=1#second',
          kind: 'direct'
        }),
      /APP-001/
    )
    assert.equal(queryResourceCount(), 2)
  })

  it('imports Magnet and ED2K resources and deduplicates their protocol identities', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const magnet = videos.importLinkResource({
      code: 'MAG-001',
      target: { kind: 'new' },
      url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Example%20Movie'
    })
    const ed2k = videos.importLinkResource({
      code: 'ED2K-001',
      target: { kind: 'new' },
      url: 'ed2k://|file|Example%20Movie.mp4|123456|ABCDEF0123456789ABCDEF0123456789|/',
      sizeBytes: 123456
    })

    assert.equal(magnet.resource.kind, 'magnet')
    assert.equal(magnet.resource.display_name, 'Example Movie')
    assert.equal(ed2k.resource.kind, 'ed2k')
    assert.equal(ed2k.resource.display_name, 'Example Movie.mp4')
    assert.equal(ed2k.resource.size_bytes, 123456)
    assert.throws(
      () =>
        videos.importLinkResource({
          code: 'OTHER-001',
      target: { kind: 'new' },
          url: 'magnet:?dn=Renamed&xt=urn:btih:abcdef1234567890'
        }),
      /MAG-001/
    )

    const updated = videos.updateLinkResource(magnet.videoId, magnet.resource.id, {
      url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Updated%20Name',
      displayName: 'Custom name',
      sizeBytes: 2048
    })
    assert.equal(updated.display_name, 'Custom name')
    assert.equal(updated.size_bytes, 2048)
    const cleared = videos.updateLinkResource(magnet.videoId, magnet.resource.id, {
      url: updated.locator,
      displayName: updated.display_name,
      sizeBytes: null
    })
    assert.equal(cleared.size_bytes, null)
  })

  it('edits metadata, status, rating, poster, and manual tags', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    videos.edit(1, { title: 'Edited', tags: ['scraped-tag'] })
    videos.setRating(1, 5)
    videos.addManualTag(1, 'manual-tag')
    videos.markScrapeSucceeded(1)

    const detail = query.get(1)
    assert.equal(detail?.title, 'Edited')
    assert.equal(detail?.rating, 5)
    assert.deepEqual(detail?.tags.map((tag) => [tag.name, tag.origin]), [
      ['scraped-tag', 'scraped'],
      ['manual-tag', 'manual']
    ])
    assert.equal(detail?.scraped_status, 1)

    const manualTag = detail?.tags.find((tag) => tag.name === 'manual-tag')
    assert.ok(manualTag)
    videos.removeManualTag(1, manualTag.id)
    assert.deepEqual(query.get(1)?.tags.map((tag) => tag.name), ['scraped-tag'])
  })

  it('imports and deletes a local sample in the temporary media directory', async () => {
    const { imagePath } = setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    const sample = await videos.importSample(1, { source: 'file', sourcePath: imagePath })
    assert.ok(sample.local_path)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), true)

    videos.setPoster(1, sample.local_path)
    videos.deleteSample(1, sample.id)
    assert.equal(fs.existsSync(path.join(tempRoot!, 'media_assets', sample.local_path)), false)
    assert.equal(query.get(1)?.poster_path, null)
  })

  it('switches the primary resource, deletes a local resource, then deletes the video', () => {
    const { videoPath } = setupDb()
    const secondaryPath = path.join(tempRoot!, 'APP-001-CD2.mp4')
    fs.writeFileSync(secondaryPath, 'video 2')
    const fileInfo = getDb()
      .prepare(
        `INSERT INTO video_resources
           (video_id, kind, locator, resource_key, is_primary)
         VALUES (1, 'local', ?, 'local:' || ?, 0)`
      )
      .run(secondaryPath, secondaryPath)
    const secondaryId = Number(fileInfo.lastInsertRowid)
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    videos.setPrimaryResource(1, secondaryId)
    videos.removeResource(1, 1)
    assert.equal(fs.existsSync(videoPath), false)
    assert.equal(query.get(1)?.resources[0]?.display_locator, secondaryPath)

    videos.delete(1)
    assert.equal(fs.existsSync(secondaryPath), false)
    assert.equal(query.get(1), null)
  })

  it('restores a staged local file and rolls back resource removal when promotion fails', () => {
    const { videoPath } = setupDb()
    const videos = createVideoMaintenanceService()
    const fallback = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/fallback'
    }).resource
    getDb().exec(`
      CREATE TRIGGER reject_primary_promotion
      BEFORE UPDATE OF is_primary ON video_resources
      WHEN NEW.is_primary = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced promotion failure');
      END;
    `)

    assert.throws(() => videos.removeResource(1, 1), /forced promotion failure/)

    assert.equal(fs.existsSync(videoPath), true)
    assert.deepEqual(
      createVideoQueryService()
        .get(1)
        ?.resources.map((resource) => [resource.id, resource.is_primary]),
      [
        [1, 1],
        [fallback.id, 0]
      ]
    )
  })

  it('sets any resource as primary and promotes deterministic fallbacks after removal', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const directOne = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://cdn.example/one.mp4',
      kind: 'direct'
    }).resource
    const directTwo = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://cdn.example/two.mp4',
      kind: 'direct'
    }).resource
    const web = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch',
      kind: 'web'
    }).resource
    const webFallback = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/fallback',
      kind: 'web'
    }).resource
    const magnet = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Fallback'
    }).resource
    const ed2k = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'ed2k://|file|Fallback.mp4|1|ABCDEF0123456789ABCDEF0123456789|/'
    }).resource

    videos.setPrimaryResource(1, web.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, web.id)

    videos.removeResource(1, web.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, 1)
    videos.removeResource(1, 1)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, directOne.id)
    videos.removeResource(1, directOne.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, directTwo.id)
    videos.removeResource(1, directTwo.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, magnet.id)
    videos.removeResource(1, magnet.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, ed2k.id)
    videos.removeResource(1, ed2k.id)
    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, webFallback.id)
  })

  it('does not promote an inaccessible local resource over an available web link', () => {
    const { videoPath } = setupDb()
    const videos = createVideoMaintenanceService()
    const direct = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://cdn.example/current.mp4',
      kind: 'direct'
    }).resource
    const web = videos.importLinkResource({
      code: 'APP-001',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/fallback',
      kind: 'web'
    }).resource
    fs.unlinkSync(videoPath)
    videos.setPrimaryResource(1, direct.id)

    videos.removeResource(1, direct.id)

    assert.equal(createVideoQueryService().get(1)?.resources[0]?.id, web.id)
  })

  it('requires an explicit decision when manually removing the last resource', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const retained = videos.importLinkResource({
      code: 'ONLY-001',
      target: { kind: 'new' },
      url: 'https://example.com/only'
    })

    assert.throws(() => videos.removeResource(retained.videoId, retained.resource.id), /最后一个资源/)
    assert.deepEqual(
      videos.removeResource(retained.videoId, retained.resource.id, 'retain-video'),
      { videoDeleted: false, promotedResourceId: null }
    )
    assert.equal(createVideoQueryService().get(retained.videoId)?.resources.length, 0)

    const deleted = videos.importLinkResource({
      code: 'ONLY-002',
      target: { kind: 'new' },
      url: 'https://example.com/delete'
    })
    assert.deepEqual(
      videos.removeResource(deleted.videoId, deleted.resource.id, 'delete-video'),
      { videoDeleted: true, promotedResourceId: null }
    )
    assert.equal(createVideoQueryService().get(deleted.videoId), null)
  })

  it('updates only the display label of a local resource', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const updated = videos.updateLocalResourceLabel(1, 1, 'Director cut')
    assert.equal(updated.display_name, 'Director cut')
    assert.equal(updated.locator.endsWith('APP-001.mp4'), true)
  })

  it('deletes a symbolic link without deleting its target file', () => {
    const { videoPath } = setupDb()
    const targetPath = path.join(tempRoot!, 'target.mp4')
    const linkPath = path.join(tempRoot!, 'linked.mp4')
    fs.writeFileSync(targetPath, 'target')
    fs.symlinkSync(targetPath, linkPath, 'file')
    getDb()
      .prepare("UPDATE video_resources SET locator = ?, resource_key = 'local:' || ? WHERE id = 1")
      .run(linkPath, linkPath)
    const videos = createVideoMaintenanceService()

    videos.delete(1)

    assert.equal(fs.existsSync(linkPath), false)
    assert.equal(fs.existsSync(targetPath), true)
    assert.equal(fs.existsSync(videoPath), true)
  })

  it('corrects an imported code', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const query = createVideoQueryService()

    assert.deepEqual(videos.correctImport(1, ' app-002 '), {
      code: 'APP-002',
      previousCode: 'APP-001'
    })
    assert.equal(query.get(1)?.code, 'APP-002')
  })

  it('deletes the source file and database row', () => {
    const { videoPath } = setupPolicyDb()
    const videos = createVideoMaintenanceService()
    videos.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch?id=535',
      kind: 'web'
    })

    videos.delete(1)

    assert.equal(fs.existsSync(videoPath), false)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c, 0)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM video_resources').get() as { c: number }).c,
      0
    )
  })

  it('persists a committed cleanup task when physical deletion must be retried', () => {
    const { videoPath } = setupPolicyDb()
    const videos = createVideoMaintenanceService({
      unlinkSync: () => {
        throw new Error('file is busy')
      }
    })

    videos.delete(1)

    assert.equal(fs.existsSync(videoPath), false)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c, 0)
    const pending = getDb()
      .prepare(
        `SELECT original_path, staged_path, state
         FROM pending_local_file_deletions`
      )
      .get() as { original_path: string; staged_path: string; state: string }
    assert.equal(pending.original_path, videoPath)
    assert.equal(pending.state, 'committed')
    assert.equal(fs.existsSync(pending.staged_path), true)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 1,
      restored: 0,
      failed: 0
    })
    assert.equal(fs.existsSync(pending.staged_path), false)
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      0
    )
  })

  it('does not delete database records when the file storage cannot be audited', () => {
    setupPolicyDb()
    const offlinePath = path.join(tempRoot!, 'offline-volume', 'IPX-535.mp4')
    getDb()
      .prepare("UPDATE video_resources SET locator = ?, resource_key = 'local:' || ? WHERE id = 1")
      .run(offlinePath, offlinePath)
    const videos = createVideoMaintenanceService()

    assert.throws(() => videos.delete(1), /无法确认影片文件是否存在/)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      1
    )
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      0
    )
  })

  it('adopts an interrupted prepared task when deletion is retried', () => {
    const { videoPath } = setupPolicyDb()
    const stagedPath = `${videoPath}.javdex-delete-retry`
    const deviceId = fs.lstatSync(videoPath).dev
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'prepared')`
      )
      .run(videoPath, stagedPath, deviceId)
    fs.renameSync(videoPath, stagedPath)

    createVideoMaintenanceService().delete(1)

    assert.equal(fs.existsSync(videoPath), false)
    assert.equal(fs.existsSync(stagedPath), false)
    assert.equal((getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c, 0)
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      0
    )
  })

  it('does not adopt a prepared task when the original path was replaced', () => {
    const { videoPath } = setupPolicyDb()
    const stagedPath = `${videoPath}.javdex-delete-conflict`
    const deviceId = fs.lstatSync(videoPath).dev
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'prepared')`
      )
      .run(videoPath, stagedPath, deviceId)
    fs.renameSync(videoPath, stagedPath)
    fs.writeFileSync(videoPath, 'replacement')

    assert.throws(() => createVideoMaintenanceService().delete(1), /原路径已被占用/)

    assert.equal(fs.existsSync(videoPath), true)
    assert.equal(fs.existsSync(stagedPath), true)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      1
    )
  })

  it('restores an interrupted pre-commit file staging task', () => {
    const { videoPath } = setupPolicyDb()
    const stagedPath = `${videoPath}.javdex-delete-interrupted`
    const deviceId = fs.lstatSync(videoPath).dev
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'prepared')`
      )
      .run(videoPath, stagedPath, deviceId)
    fs.renameSync(videoPath, stagedPath)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 0,
      restored: 1,
      failed: 0
    })
    assert.equal(fs.existsSync(videoPath), true)
    assert.equal(fs.existsSync(stagedPath), false)
  })

  it('keeps a cleanup task queued while its original storage is unavailable', () => {
    setupPolicyDb()
    const offlineRoot = path.join(tempRoot!, 'offline-volume')
    const originalPath = path.join(offlineRoot, 'movie.mp4')
    const stagedPath = `${originalPath}.javdex-delete-interrupted`
    const expectedDeviceId = fs.lstatSync(tempRoot!).dev + 1
    fs.mkdirSync(offlineRoot)
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'committed')`
      )
      .run(originalPath, stagedPath, expectedDeviceId)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 0,
      restored: 0,
      failed: 1
    })
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      1
    )
  })

  it('finishes cleanup after a storage remount changes its device id', () => {
    setupPolicyDb()
    const stagedPath = path.join(tempRoot!, 'remounted.mp4.javdex-delete-interrupted')
    fs.writeFileSync(stagedPath, 'staged')
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'committed')`
      )
      .run(path.join(tempRoot!, 'remounted.mp4'), stagedPath, fs.lstatSync(stagedPath).dev + 1)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 1,
      restored: 0,
      failed: 0
    })
    assert.equal(fs.existsSync(stagedPath), false)
  })

  it('retains a pre-rename prepared task when another device occupies the original path', () => {
    const { videoPath } = setupPolicyDb()
    const stagedPath = `${videoPath}.javdex-delete-before-rename`
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'prepared')`
      )
      .run(videoPath, stagedPath, fs.lstatSync(videoPath).dev + 1)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 0,
      restored: 0,
      failed: 1
    })
    assert.equal(fs.existsSync(videoPath), true)
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      1
    )
  })

  it('retains prepared state and database records when both file paths are missing', () => {
    setupPolicyDb()
    const originalPath = path.join(tempRoot!, 'missing.mp4')
    const stagedPath = `${originalPath}.javdex-delete-missing`
    const deviceId = fs.lstatSync(tempRoot!).dev
    getDb()
      .prepare(
        `INSERT INTO pending_local_file_deletions (
           original_path, staged_path, device_id, state
         ) VALUES (?, ?, ?, 'prepared')`
      )
      .run(originalPath, stagedPath, deviceId)
    getDb()
      .prepare("UPDATE video_resources SET locator = ?, resource_key = 'local:' || ? WHERE id = 1")
      .run(originalPath, originalPath)

    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 0,
      restored: 0,
      failed: 1
    })
    assert.throws(
      () => createVideoMaintenanceService().delete(1),
      /暂存文件和原文件均不存在/
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      1
    )
    assert.equal(
      (
        getDb().prepare('SELECT COUNT(*) AS c FROM pending_local_file_deletions').get() as {
          c: number
        }
      ).c,
      1
    )
  })

  it('restores staged local files when deleting the video record fails', () => {
    const { videoPath } = setupPolicyDb()
    const videos = createVideoMaintenanceService()
    getDb().exec(`
      CREATE TRIGGER reject_video_deletion
      BEFORE DELETE ON videos
      BEGIN
        SELECT RAISE(ABORT, 'forced video deletion failure');
      END;
    `)

    assert.throws(() => videos.delete(1), /forced video deletion failure/)

    assert.equal(fs.existsSync(videoPath), true)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS count FROM videos WHERE id = 1').get() as {
        count: number
      }).count,
      1
    )
    assert.equal(
      (
        getDb()
          .prepare('SELECT locator FROM video_resources WHERE video_id = 1 AND kind = \'local\'')
          .get() as { locator: string }
      ).locator,
      videoPath
    )
  })

  it('keeps the prepared task when storage disappears during transaction rollback', () => {
    const { videoPath } = setupPolicyDb()
    const mediaDir = path.join(tempRoot!, 'media-volume')
    const offlineDir = path.join(tempRoot!, 'media-volume-offline')
    const relocatedPath = path.join(mediaDir, path.basename(videoPath))
    fs.mkdirSync(mediaDir)
    fs.renameSync(videoPath, relocatedPath)
    getDb()
      .prepare("UPDATE video_resources SET locator = ?, resource_key = 'local:' || ? WHERE id = 1")
      .run(relocatedPath, relocatedPath)
    const videos = createVideoMaintenanceService({
      runDatabaseTransaction: <T>(_work: () => T): T => {
        fs.renameSync(mediaDir, offlineDir)
        throw new Error('forced transaction failure')
      }
    })

    assert.throws(() => videos.delete(1), /暂存文件所在存储当前不可用/)
    const pending = getDb()
      .prepare(
        `SELECT staged_path, state
         FROM pending_local_file_deletions`
      )
      .get() as { staged_path: string; state: string }
    assert.equal(pending.state, 'prepared')
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      1
    )

    fs.renameSync(offlineDir, mediaDir)
    assert.deepEqual(recoverPendingLocalFileDeletions(), {
      cleaned: 0,
      restored: 1,
      failed: 0
    })
    assert.equal(fs.existsSync(relocatedPath), true)
    assert.equal(fs.existsSync(pending.staged_path), false)
  })

  it('clears scraped metadata and relations but keeps manual tags', () => {
    setupPolicyDb()
    const db = getDb()
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('Drama')
    db.prepare('INSERT INTO tags (name) VALUES (?)').run('收藏')
    db.prepare(
      `INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 1, 'scraped')`
    ).run()
    db.prepare(
      `INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 2, 'manual')`
    ).run()
    db.prepare(
      `INSERT INTO video_external_stats (video_id, source, rating_average, rating_count)
       VALUES (1, 'JavLibrary', 3.5, 100)`
    ).run()
    const videos = createVideoMaintenanceService()

    videos.clearMetadata(1)

    const row = db.prepare('SELECT title, summary, maker_organization_id, scraped_status FROM videos WHERE id = 1').get() as {
      title: string | null
      summary: string | null
      maker_organization_id: number | null
      scraped_status: number
    }
    assert.deepEqual(row, {
      title: null,
      summary: null,
      maker_organization_id: null,
      scraped_status: 0
    })
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM video_tag').get() as { c: number }).c, 1)
    const kept = db.prepare('SELECT t.name FROM tags t JOIN video_tag vt ON vt.tag_id = t.id').get() as {
      name: string
    }
    assert.equal(kept.name, '收藏')
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM video_external_stats WHERE video_id = 1').get() as { c: number })
        .c,
      0
    )
  })

  it('corrects to an already used code without implicitly merging videos', () => {
    const { videoPath } = setupPolicyDb()
    const db = getDb()
    const missingPath = path.join(tempRoot!, 'missing.mp4')
    insertTestVideoWithFile(db, {
      code: 'MUKD-501',
      filePath: missingPath,
      scrapedStatus: 0
    })
    const videos = createVideoMaintenanceService()
    const linked = videos.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch/source',
      kind: 'web'
    }).resource

    const result = videos.correctImport(1, 'MUKD-501')

    assert.deepEqual(result, { code: 'MUKD-501', previousCode: 'IPX-535' })
    const videosRows = db.prepare('SELECT id, code FROM videos ORDER BY id').all() as Array<{
      id: number
      code: string
    }>
    assert.deepEqual(videosRows, [
      { id: 1, code: 'MUKD-501' },
      { id: 2, code: 'MUKD-501' }
    ])
    const resources = db
      .prepare('SELECT video_id, kind, locator FROM video_resources ORDER BY id')
      .all() as Array<{ video_id: number; kind: string; locator: string }>
    assert.deepEqual(resources, [
      { video_id: 1, kind: 'local', locator: videoPath },
      { video_id: 2, kind: 'local', locator: missingPath },
      { video_id: 1, kind: 'web', locator: linked.locator }
    ])
  })

  it('explicitly merges same-code videos while preserving the chosen id and primary resource', () => {
    const { videoPath } = setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'duplicate.mp4')
    fs.writeFileSync(sourcePath, 'duplicate')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath,
      title: 'Source title',
      summary: 'Source summary',
      publisher: 'Publisher',
      scrapedStatus: 2
    })
    db.prepare("UPDATE videos SET title = NULL, scraped_status = 1 WHERE id = 1").run()
    db.prepare("INSERT INTO tags (name) VALUES ('Keep manual')").run()
    db.prepare("INSERT INTO tags (name) VALUES ('Source tag')").run()
    db.prepare("INSERT INTO video_tag (video_id, tag_id, origin) VALUES (1, 1, 'manual')").run()
    db.prepare("INSERT INTO video_tag (video_id, tag_id, origin) VALUES (?, 2, 'scraped')").run(
      source.videoId
    )

    const result = createVideoMaintenanceService().mergeVideos({
      retainedVideoId: 1,
      sourceVideoId: source.videoId
    })

    assert.deepEqual(result, { retainedVideoId: 1, deletedVideoId: source.videoId })
    assert.deepEqual(
      db.prepare('SELECT id, code, title, summary, scraped_status FROM videos').all(),
      [
        {
          id: 1,
          code: 'IPX-535',
          title: 'Source title',
          summary: 'Summary',
          scraped_status: 1
        }
      ]
    )
    assert.deepEqual(
      db
        .prepare('SELECT locator, is_primary FROM video_resources WHERE video_id = 1 ORDER BY id')
        .all(),
      [
        { locator: videoPath, is_primary: 1 },
        { locator: sourcePath, is_primary: 0 }
      ]
    )
    assert.deepEqual(
      db
        .prepare(
          'SELECT t.name, vt.origin FROM video_tag vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = 1 ORDER BY t.id'
        )
        .all(),
      [
        { name: 'Keep manual', origin: 'manual' },
        { name: 'Source tag', origin: 'scraped' }
      ]
    )
  })

  it('unions manual tags but keeps the retained scraped-tag field as a whole', () => {
    setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'tag-source.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath
    })
    db.prepare(
      "INSERT INTO tags (id, name) VALUES (101, 'Retained scraped'), (102, 'Source scraped'), (103, 'Source manual')"
    ).run()
    db.prepare(
      "INSERT INTO video_tag (video_id, tag_id, origin, source) VALUES (1, 101, 'scraped', 'retained-site')"
    ).run()
    db.prepare(
      "INSERT INTO video_tag (video_id, tag_id, origin, source) VALUES (?, 102, 'scraped', 'source-site')"
    ).run(source.videoId)
    db.prepare(
      "INSERT INTO video_tag (video_id, tag_id, origin) VALUES (?, 103, 'manual')"
    ).run(source.videoId)

    createVideoMaintenanceService().mergeVideos({
      retainedVideoId: 1,
      sourceVideoId: source.videoId
    })

    assert.deepEqual(
      db
        .prepare(
          `SELECT t.name, vt.origin, vt.source
           FROM video_tag vt JOIN tags t ON t.id = vt.tag_id
           WHERE vt.video_id = 1 AND t.id >= 101 ORDER BY t.id`
        )
        .all(),
      [
        { name: 'Retained scraped', origin: 'scraped', source: 'retained-site' },
        { name: 'Source manual', origin: 'manual', source: null }
      ]
    )
  })

  it('unions cast, playlists, sources, and ratings while preserving retained conflicts and scrape history', () => {
    setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'relation-source.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath,
      scrapedStatus: 1
    })
    db.prepare(
      "UPDATE videos SET scraped_status = 2, last_scraped_at = '2024-01-01T00:00:00.000Z' WHERE id = 1"
    ).run()
    db.prepare(
      "UPDATE videos SET last_scraped_at = '2025-02-03T00:00:00.000Z' WHERE id = ?"
    ).run(source.videoId)
    db.prepare(
      "INSERT INTO actresses (id, main_name, gender) VALUES (101, 'Retained Cast', 'female'), (102, 'Source Cast', 'female')"
    ).run()
    db.prepare(
      'INSERT INTO video_actress (video_id, actress_id) VALUES (1, 101), (?, 101), (?, 102)'
    ).run(source.videoId, source.videoId)
    db.prepare(
      "INSERT INTO playlists (id, name) VALUES (201, 'Both'), (202, 'Source only')"
    ).run()
    db.prepare(
      `INSERT INTO playlist_video (playlist_id, video_id, position, added_at)
       VALUES (201, 1, 5, '2024-01-01'), (201, ?, 9, '2025-01-01'),
              (202, ?, 3, '2025-01-02')`
    ).run(source.videoId, source.videoId)
    db.prepare(
      `INSERT INTO video_sources (video_id, source, url, fetched_at)
       VALUES (1, 'same', 'https://retained.example', '2024-01-01'),
              (?, 'same', 'https://source.example', '2025-01-01'),
              (?, 'other', 'https://other.example', '2025-01-02')`
    ).run(source.videoId, source.videoId)
    db.prepare(
      `INSERT INTO video_external_stats (
         video_id, source, rating_average, rating_count, fetched_at
       ) VALUES (1, 'same', 3.5, 10, '2024-01-01'),
                (?, 'same', 4.5, 20, '2025-01-01'),
                (?, 'other', 4.0, 15, '2025-01-02')`
    ).run(source.videoId, source.videoId)

    createVideoMaintenanceService().mergeVideos({
      retainedVideoId: 1,
      sourceVideoId: source.videoId
    })

    assert.deepEqual(
      db.prepare('SELECT actress_id FROM video_actress WHERE video_id = 1 ORDER BY actress_id').all(),
      [{ actress_id: 101 }, { actress_id: 102 }]
    )
    assert.deepEqual(
      db.prepare(
        'SELECT playlist_id, position FROM playlist_video WHERE video_id = 1 ORDER BY playlist_id'
      ).all(),
      [{ playlist_id: 201, position: 5 }, { playlist_id: 202, position: 3 }]
    )
    assert.deepEqual(
      db.prepare('SELECT source, url FROM video_sources WHERE video_id = 1 ORDER BY source').all(),
      [
        { source: 'other', url: 'https://other.example' },
        { source: 'same', url: 'https://retained.example' }
      ]
    )
    assert.deepEqual(
      db.prepare(
        `SELECT source, rating_average, rating_count
         FROM video_external_stats WHERE video_id = 1 ORDER BY source`
      ).all(),
      [
        { source: 'other', rating_average: 4, rating_count: 15 },
        { source: 'same', rating_average: 3.5, rating_count: 10 }
      ]
    )
    assert.deepEqual(
      db.prepare('SELECT scraped_status, last_scraped_at FROM videos WHERE id = 1').get(),
      { scraped_status: 1, last_scraped_at: '2025-02-03T00:00:00.000Z' }
    )
  })

  it('merges cover, poster, and sample fields as whole sets and reclaims only unused media', () => {
    setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'media-source.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath
    })
    db.prepare(
      "UPDATE videos SET cover_path = 'covers/retained.jpg', poster_path = NULL WHERE id = 1"
    ).run()
    db.prepare(
      "UPDATE videos SET cover_path = 'covers/source.jpg', poster_path = 'samples/source-poster.jpg' WHERE id = ?"
    ).run(source.videoId)
    db.prepare(
      `INSERT INTO video_assets (video_id, type, position, local_path, is_primary)
       VALUES
         (1, 'sample', 0, 'samples/retained.jpg', 1),
         (?, 'sample', 0, 'samples/source-poster.jpg', 1),
         (?, 'sample', 1, 'samples/source-extra.jpg', 0)`
    ).run(source.videoId, source.videoId)
    const deletedPaths: string[] = []

    createVideoMaintenanceService({
      deleteBestEffort(storedPath) {
        if (storedPath) deletedPaths.push(storedPath)
      }
    }).mergeVideos({ retainedVideoId: 1, sourceVideoId: source.videoId })

    assert.deepEqual(
      db.prepare('SELECT cover_path, poster_path FROM videos WHERE id = 1').get(),
      { cover_path: 'covers/retained.jpg', poster_path: 'samples/source-poster.jpg' }
    )
    assert.deepEqual(
      db
        .prepare(
          "SELECT local_path FROM video_assets WHERE video_id = 1 AND type = 'sample' ORDER BY position, id"
        )
        .all(),
      [{ local_path: 'samples/retained.jpg' }]
    )
    assert.deepEqual(deletedPaths.sort(), [
      'covers/source.jpg',
      'samples/source-extra.jpg'
    ])
  })

  it('rejects a merge whose combined identity belongs to a third video', () => {
    setupPolicyDb()
    const db = getDb()
    db.prepare("UPDATE videos SET release_date = '2024-01-01' WHERE id = 1").run()
    const sourcePath = path.join(tempRoot!, 'third-party-source.mp4')
    const conflictingPath = path.join(tempRoot!, 'third-party-conflict.mp4')
    fs.writeFileSync(sourcePath, 'source')
    fs.writeFileSync(conflictingPath, 'conflict')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath,
      publisher: 'Third-party Publisher'
    })
    const conflict = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: conflictingPath,
      publisher: 'Third-party Publisher',
      releaseDate: '2024-01-01'
    })

    assert.throws(
      () =>
        createVideoMaintenanceService().mergeVideos({
          retainedVideoId: 1,
          sourceVideoId: source.videoId
        }),
      new RegExp(`影片 ID ${conflict.videoId}`)
    )

    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      3
    )
    assert.deepEqual(
      db.prepare('SELECT publisher_organization_id, release_date FROM videos WHERE id = 1').get(),
      { publisher_organization_id: null, release_date: '2024-01-01' }
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM video_resources').get() as { c: number }).c,
      3
    )
  })

  it('rolls back an ordinary merge when deleting the source record fails', () => {
    setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'merge-rollback-source.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath,
      title: 'Source value'
    })
    db.prepare('UPDATE videos SET title = NULL WHERE id = 1').run()
    db.exec(`
      CREATE TRIGGER fail_source_video_delete
      BEFORE DELETE ON videos
      WHEN OLD.id = ${source.videoId}
      BEGIN
        SELECT RAISE(ABORT, 'forced source delete failure');
      END;
    `)

    assert.throws(
      () =>
        createVideoMaintenanceService().mergeVideos({
          retainedVideoId: 1,
          sourceVideoId: source.videoId
        }),
      /forced source delete failure/
    )

    assert.deepEqual(
      db.prepare('SELECT id, title FROM videos ORDER BY id').all(),
      [
        { id: 1, title: null },
        { id: source.videoId, title: 'Source value' }
      ]
    )
    assert.deepEqual(
      db.prepare('SELECT id, video_id FROM video_resources ORDER BY id').all(),
      [
        { id: 1, video_id: 1 },
        { id: source.fileId, video_id: source.videoId }
      ]
    )
  })

  it('rejects merging videos with different normalized codes', () => {
    setupPolicyDb()
    const sourcePath = path.join(tempRoot!, 'different-code.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(getDb(), {
      code: 'MUKD-501',
      filePath: sourcePath
    })

    assert.throws(
      () =>
        createVideoMaintenanceService().mergeVideos({
          retainedVideoId: 1,
          sourceVideoId: source.videoId
        }),
      /番号相同/
    )
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      2
    )
  })

  it('uses the normal availability-aware promotion rule when neither merged video has a primary', () => {
    const { videoPath } = setupPolicyDb()
    const db = getDb()
    const sourcePath = path.join(tempRoot!, 'fallback-source.mp4')
    fs.writeFileSync(sourcePath, 'source')
    const source = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: sourcePath
    })
    const service = createVideoMaintenanceService()
    const direct = service.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: source.videoId },
      url: 'https://example.com/fallback.mp4',
      kind: 'direct'
    }).resource
    db.prepare('UPDATE video_resources SET is_primary = 0 WHERE video_id IN (1, ?)').run(
      source.videoId
    )
    fs.unlinkSync(videoPath)
    fs.unlinkSync(sourcePath)

    service.mergeVideos({ retainedVideoId: 1, sourceVideoId: source.videoId })

    assert.deepEqual(
      db.prepare('SELECT id, is_primary FROM video_resources WHERE video_id = 1 ORDER BY id').all(),
      [
        { id: 1, is_primary: 0 },
        { id: source.fileId, is_primary: 0 },
        { id: direct.id, is_primary: 1 }
      ]
    )
  })

  it('splits a non-primary resource into a metadata-empty pending-identity video', () => {
    setupPolicyDb()
    const videos = createVideoMaintenanceService()
    const secondary = videos.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch/secondary',
      kind: 'web'
    }).resource

    const result = videos.splitResource(1, secondary.id)

    assert.notEqual(result.videoId, 1)
    assert.equal(result.resourceId, secondary.id)
    assert.deepEqual(
      getDb()
        .prepare(
          `SELECT code, title, release_date, publisher_organization_id, scraped_status
           FROM videos WHERE id = ?`
        )
        .get(result.videoId),
      {
        code: 'IPX-535',
        title: null,
        release_date: null,
        publisher_organization_id: null,
        scraped_status: 0
      }
    )
    assert.deepEqual(
      getDb()
        .prepare('SELECT video_id, is_primary FROM video_resources WHERE id = ?')
        .get(secondary.id),
      { video_id: result.videoId, is_primary: 1 }
    )
  })

  it('blocks primary splitting and rolls back a failed non-primary split', () => {
    setupPolicyDb()
    const db = getDb()
    const service = createVideoMaintenanceService()
    const secondary = service.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: 1 },
      url: 'magnet:?xt=urn:btih:1234567890abcdef1234567890abcdef12345678',
      kind: 'magnet'
    }).resource

    assert.throws(() => service.splitResource(1, 1), /先将另一条资源设为主资源/)
    db.exec(`
      CREATE TRIGGER fail_resource_split
      BEFORE UPDATE OF video_id ON video_resources
      WHEN OLD.id = ${secondary.id}
      BEGIN
        SELECT RAISE(ABORT, 'forced resource split failure');
      END;
    `)

    assert.throws(
      () => service.splitResource(1, secondary.id),
      /forced resource split failure/
    )
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM videos').get() as { c: number }).c,
      1
    )
    assert.deepEqual(
      db.prepare('SELECT video_id, is_primary FROM video_resources WHERE id = ?').get(secondary.id),
      { video_id: 1, is_primary: 0 }
    )
  })

  it('locks metadata while a video scrape result is pending but still allows resource splitting', () => {
    setupPolicyDb()
    const db = getDb()
    db.prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, selected_fields_json, applicable_fields_json, update_mode,
         request_json, warnings_json, created_at, updated_at
       ) VALUES (1, '[]', '[]', 'replace', '{}', '[]', '2025-01-01', '2025-01-01')`
    ).run()
    const videos = createVideoMaintenanceService()
    const secondary = videos.importLinkResource({
      code: 'IPX-535',
      target: { kind: 'existing', videoId: 1 },
      url: 'https://example.com/watch/pending-split',
      kind: 'web'
    }).resource

    assert.throws(() => videos.edit(1, { title: 'Must not persist' }), /待确认.*刮削/)
    assert.equal((db.prepare('SELECT title FROM videos WHERE id = 1').get() as { title: string }).title, 'Title')
    assert.doesNotThrow(() => videos.splitResource(1, secondary.id))
  })

  it('requires confirmation before correcting a pending video and clears staging atomically', () => {
    setupPolicyDb()
    const db = getDb()
    const pendingId = Number(db.prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, selected_fields_json, applicable_fields_json, update_mode,
         request_json, warnings_json, created_at, updated_at
       ) VALUES (1, '[]', '[]', 'replace', '{}', '[]', '2025-01-01', '2025-01-01')`
    ).run().lastInsertRowid)
    const sourceId = Number(db.prepare(
      `INSERT INTO pending_video_scrape_sources (
         pending_scrape_id, plugin_name, plugin_source, plugin_config_json,
         source_name, selected_fields_json
       ) VALUES (?, 'test', 'builtin', '{}', 'test', '[]')`
    ).run(pendingId).lastInsertRowid)
    const candidateId = Number(db.prepare(
      "INSERT INTO pending_video_scrape_candidates (source_id, result_json) VALUES (?, '{\"code\":\"IPX-535\"}')"
    ).run(sourceId).lastInsertRowid)
    db.prepare(
      "INSERT INTO pending_video_scrape_resources (candidate_id, field, staged_path) VALUES (?, 'cover', 'stage/cover.jpg')"
    ).run(candidateId)
    const cleaned: string[][] = []
    const videos = createVideoMaintenanceService({
      cleanupVideoScrapeStagingPaths(paths) {
        cleaned.push(paths)
      }
    })

    assert.deepEqual(videos.correctImport(1, 'NEW-535'), {
      code: 'NEW-535',
      previousCode: 'IPX-535',
      pendingDiscardRequired: true
    })
    assert.equal((db.prepare('SELECT code FROM videos WHERE id = 1').get() as { code: string }).code, 'IPX-535')
    assert.equal(db.prepare('SELECT 1 FROM pending_video_scrapes WHERE video_id = 1').get() != null, true)

    assert.deepEqual(videos.correctImport(1, 'NEW-535', true), {
      code: 'NEW-535',
      previousCode: 'IPX-535'
    })
    assert.equal(db.prepare('SELECT 1 FROM pending_video_scrapes WHERE video_id = 1').get(), undefined)
    assert.deepEqual(cleaned, [['stage/cover.jpg']])
  })

  it('cleans pending scrape staging when deleting a video', () => {
    setupPolicyDb()
    const db = getDb()
    const pendingId = Number(db.prepare(
      `INSERT INTO pending_video_scrapes (
         video_id, selected_fields_json, applicable_fields_json, update_mode,
         request_json, warnings_json, created_at, updated_at
       ) VALUES (1, '[]', '[]', 'replace', '{}', '[]', '2025-01-01', '2025-01-01')`
    ).run().lastInsertRowid)
    const sourceId = Number(db.prepare(
      `INSERT INTO pending_video_scrape_sources (
         pending_scrape_id, plugin_name, plugin_source, plugin_config_json,
         source_name, selected_fields_json
       ) VALUES (?, 'test', 'builtin', '{}', 'test', '[]')`
    ).run(pendingId).lastInsertRowid)
    const candidateId = Number(db.prepare(
      "INSERT INTO pending_video_scrape_candidates (source_id, result_json) VALUES (?, '{\"code\":\"IPX-535\"}')"
    ).run(sourceId).lastInsertRowid)
    db.prepare(
      "INSERT INTO pending_video_scrape_resources (candidate_id, field, staged_path) VALUES (?, 'cover', 'stage/delete.jpg')"
    ).run(candidateId)
    const cleaned: string[][] = []

    createVideoMaintenanceService({
      cleanupVideoScrapeStagingPaths(paths) {
        cleaned.push(paths)
      }
    }).delete(1)

    assert.equal(db.prepare('SELECT 1 FROM videos WHERE id = 1').get(), undefined)
    assert.deepEqual(cleaned, [['stage/delete.jpg']])
  })

  it('rolls back the whole edit when it would create a complete business identity conflict', () => {
    setupPolicyDb()
    const db = getDb()
    const publisherId = Number(
      db.prepare("INSERT INTO organizations (main_name) VALUES ('Publisher')").run().lastInsertRowid
    )
    db.prepare(
      "INSERT INTO organization_names (organization_id, name, normalized_name, type) VALUES (?, 'Publisher', 'publisher', 'main')"
    ).run(publisherId)
    db.prepare(
      "INSERT INTO organization_name_ownership (normalized_name, organization_id) VALUES ('publisher', ?)"
    ).run(publisherId)
    db.prepare(
      "INSERT INTO organization_roles (organization_id, role) VALUES (?, 'publisher')"
    ).run(publisherId)
    db.prepare(
      "UPDATE videos SET publisher_organization_id = ?, release_date = '2024-01-01' WHERE id = 1"
    ).run(publisherId)
    const secondPath = path.join(tempRoot!, 'identity-conflict.mp4')
    fs.writeFileSync(secondPath, 'second')
    const second = insertTestVideoWithFile(db, {
      code: 'IPX-535',
      filePath: secondPath,
      title: 'Original second title',
      releaseDate: '2024-01-01'
    })

    assert.throws(
      () =>
        createVideoMaintenanceService().edit(second.videoId, {
          title: 'Must roll back',
          publisherOrganization: { organizationId: publisherId }
        }),
      /UNIQUE constraint failed|影片业务身份冲突/
    )
    assert.deepEqual(
      db.prepare('SELECT title, publisher_organization_id FROM videos WHERE id = ?').get(second.videoId),
      { title: 'Original second title', publisher_organization_id: null }
    )
  })
})

function queryResourceCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number }
  ).count
}
