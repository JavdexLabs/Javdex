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
      publisherOrganization: { createName: 'Ｓtudio　Ｏne' }
    })

    const video = query.get(1)
    assert.equal(video?.maker, 'Studio One')
    assert.equal(video?.publisher, 'Studio One')
    assert.ok(video?.maker_organization_id)
    assert.equal(video?.publisher_organization_id, video?.maker_organization_id)
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
      url: 'https://cdn.example/APP-001.mp4?token=one',
      kind: 'direct',
      displayName: 'Remote copy',
      sizeBytes: 1024
    })
    const created = videos.importLinkResource({
      code: 'NEW-002',
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

  it('reports the owning video when a normalized HTTP resource already exists', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    videos.importLinkResource({
      code: 'APP-001',
      url: 'https://EXAMPLE.com:443/watch?a=1#first',
      kind: 'web'
    })

    assert.throws(
      () =>
        videos.importLinkResource({
          code: 'OTHER-002',
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
      url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Example%20Movie'
    })
    const ed2k = videos.importLinkResource({
      code: 'ED2K-001',
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

  it('sets any resource as primary and promotes deterministic fallbacks after removal', () => {
    setupDb()
    const videos = createVideoMaintenanceService()
    const directOne = videos.importLinkResource({
      code: 'APP-001',
      url: 'https://cdn.example/one.mp4',
      kind: 'direct'
    }).resource
    const directTwo = videos.importLinkResource({
      code: 'APP-001',
      url: 'https://cdn.example/two.mp4',
      kind: 'direct'
    }).resource
    const web = videos.importLinkResource({
      code: 'APP-001',
      url: 'https://example.com/watch',
      kind: 'web'
    }).resource
    const webFallback = videos.importLinkResource({
      code: 'APP-001',
      url: 'https://example.com/fallback',
      kind: 'web'
    }).resource
    const magnet = videos.importLinkResource({
      code: 'APP-001',
      url: 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Fallback'
    }).resource
    const ed2k = videos.importLinkResource({
      code: 'APP-001',
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
      url: 'https://cdn.example/current.mp4',
      kind: 'direct'
    }).resource
    const web = videos.importLinkResource({
      code: 'APP-001',
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

    assert.deepEqual(videos.correctImport(1, 'APP-002'), {
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

    const row = db.prepare('SELECT title, summary, maker, scraped_status FROM videos WHERE id = 1').get() as {
      title: string | null
      summary: string | null
      maker: string | null
      scraped_status: number
    }
    assert.deepEqual(row, { title: null, summary: null, maker: null, scraped_status: 0 })
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

  it('merges into an existing code when the existing file is missing', () => {
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
      url: 'https://example.com/watch/source',
      kind: 'web'
    }).resource

    const result = videos.correctImport(1, 'MUKD-501')

    assert.equal(result.mergedIntoId, 2)
    const videosRows = db.prepare('SELECT id, code FROM videos ORDER BY id').all() as Array<{
      id: number
      code: string
    }>
    assert.deepEqual(videosRows, [{ id: 2, code: 'MUKD-501' }])
    const resources = db
      .prepare('SELECT video_id, kind, locator FROM video_resources ORDER BY id')
      .all() as Array<{ video_id: number; kind: string; locator: string }>
    assert.deepEqual(resources, [
      { video_id: 2, kind: 'local', locator: videoPath },
      { video_id: 2, kind: 'web', locator: linked.locator }
    ])
  })
})

function queryResourceCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS count FROM video_resources').get() as { count: number }
  ).count
}
