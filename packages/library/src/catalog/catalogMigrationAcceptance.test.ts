import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { configureLibraryHost, resetLibraryHostForTests } from '@library/runtime/host'
import { scanCoordinator } from '@library/scan/scanCoordinator'
import { recoverCatalogImages } from './catalogImageRecovery'
import { ensureCatalogIdentity, readCatalogIdentity } from './catalogIdentity'
import { issueCatalogMigrationToken, authenticateMigration } from './catalogMigrationAuth'
import {
  enableCatalogMigration,
  openIsolatedCatalog,
  previewCatalogMigration,
  stageMigrationPackageFile,
  startCatalogMigration,
  migrationPackagePath
} from './catalogMigration'

function insertRoot(
  db: ReturnType<typeof openIsolatedCatalog>,
  libraryId: number,
  dir: string
): number {
  const identity = resolveMediaLibraryRootIdentity(dir)
  const timestamp = new Date().toISOString()
  const row = db
    .prepare(
      `INSERT INTO media_library_roots (
         library_id, path, normalized_path, real_path, normalized_real_path,
         device_id, inode, position, state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`
    )
    .run(
      libraryId,
      identity.path,
      identity.normalizedPath,
      identity.realPath,
      identity.normalizedRealPath,
      identity.deviceId,
      identity.inode,
      timestamp,
      timestamp
    )
  return Number(row.lastInsertRowid)
}

describe('catalog migration first scan and orphan staging', { concurrency: false }, () => {
  const roots: string[] = []
  afterEach(async () => {
    await scanCoordinator.stopAndDrain().catch(() => undefined)
    scanCoordinator.resetAfterStop()
    closeDatabase()
    resetLibraryHostForTests()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps resource-less members on the first real scan after enable, then deletes them if cleanup is turned back on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s13-m12-'))
    roots.push(root)
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    const mappedMount = path.join(root, 'mount-mapped')
    const unmappedMount = path.join(root, 'mount-unmapped')
    const targetMount = path.join(root, 'mount-target')
    for (const dir of [sourceDir, targetDir, mappedMount, unmappedMount, targetMount]) fs.mkdirSync(dir)
    const sourceImages = path.join(sourceDir, 'media_assets')
    const targetImages = path.join(targetDir, 'media_assets')
    fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
    fs.mkdirSync(targetImages, { recursive: true })
    const coverRel = 'covers/s13-m12.png'
    fs.writeFileSync(path.join(sourceImages, coverRel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))

    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    const targetDb = openIsolatedCatalog(path.join(targetDir, 'library.db'))
    let mappedRootId = 0
    try {
      ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      ensureCatalogIdentity({ serverId: randomUUID() }, targetDb)
      mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const unmappedRootId = insertRoot(sourceDb, 1, unmappedMount)
      sourceDb
        .prepare(
          `UPDATE media_library_configs
              SET remove_resource_less_memberships = 1, auto_import_local_nfo = 0
            WHERE library_id = 1`
        )
        .run()
      const localFile = path.join(mappedMount, 'S13-M12.mp4')
      fs.writeFileSync(localFile, 'video')
      const inserted = insertTestVideoWithFile(sourceDb, {
        code: 'S13-M12',
        title: 'Mapped clip',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
      })
      sourceDb.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRel, inserted.videoId)
      const orphanFile = path.join(unmappedMount, 'S13-ORPHAN.mp4')
      fs.writeFileSync(orphanFile, 'orphan')
      insertTestVideoWithFile(sourceDb, {
        code: 'S13-ORPHAN',
        title: 'Unmapped only',
        filePath: orphanFile,
        libraryId: 1,
        rootId: unmappedRootId
      })

      const sourceHost = {
        appVersion: '0.7.0',
        userDataPath: sourceDir,
        imagesDir: sourceImages,
        mediaMounts: { mapped: mappedMount }
      }
      const preview = previewCatalogMigration(
        { mappings: [{ sourceRootId: mappedRootId, targetMountSelectionId: 'mapped' }] },
        sourceHost,
        sourceDb
      )
      assert.deepEqual(preview.autoCleanupDisabledLibraryIds, [1])
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceHost,
        sourceDb
      )
      configureLibraryHost({
        userDataPath: () => targetDir,
        assets: { assetEncryption: () => false, mediaAssetsPath: () => targetImages },
        mediaMounts: () => ({ mapped: targetMount })
      })
      const targetHost = {
        appVersion: '0.7.0',
        userDataPath: targetDir,
        imagesDir: targetImages,
        mediaMounts: { mapped: targetMount }
      }
      const issued = issueCatalogMigrationToken({}, targetDb)
      authenticateMigration(issued.oneTimeToken, targetDb)
      stageMigrationPackageFile(preview.migrationId, migrationPackagePath(preview.migrationId, sourceHost), targetHost)
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      const enabled = enableCatalogMigration(
        { confirmSourceStopped: true, migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      assert.equal(enabled.phase, 'enabled')
    } finally {
      sourceDb.close()
      targetDb.close()
    }

    process.env.JAVDEX_TEST_USER_DATA = targetDir
    configureLibraryHost({
      userDataPath: () => targetDir,
      assets: { assetEncryption: () => false, mediaAssetsPath: () => targetImages },
      mediaMounts: () => ({ mapped: targetMount })
    })
    initDatabaseAtPath(path.join(targetDir, 'library.db'))
    getDb()
      .prepare('UPDATE media_library_configs SET auto_import_local_nfo = 0 WHERE library_id = 1')
      .run()
    const mappedLocal = getDb()
      .prepare("SELECT locator FROM video_resources WHERE kind = 'local'")
      .get() as { locator: string }
    fs.mkdirSync(path.dirname(mappedLocal.locator), { recursive: true })
    fs.copyFileSync(path.join(mappedMount, 'S13-M12.mp4'), mappedLocal.locator)

    const first = await scanCoordinator.run({ libraryId: 1, trigger: 'manual' })
    assert.deepEqual(first.offlineFolders, [], JSON.stringify(first))
    assert.equal(first.deletedVideos, 0)
    const afterFirst = getDb()
      .prepare(
        `SELECT video.code AS code, membership.video_id AS videoId
           FROM library_video_memberships membership
           JOIN videos video ON video.id = membership.video_id
          WHERE membership.library_id = 1
          ORDER BY video.code`
      )
      .all() as Array<{ code: string; videoId: number }>
    assert.deepEqual(
      afterFirst.map((row) => row.code),
      ['S13-M12', 'S13-ORPHAN']
    )
    const orphanResources = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM video_resources resource
             JOIN videos video ON video.id = resource.video_id
            WHERE video.code = 'S13-ORPHAN'`
        )
        .get() as { n: number }
    ).n
    assert.equal(orphanResources, 0)

    getDb()
      .prepare('UPDATE media_library_configs SET remove_resource_less_memberships = 1 WHERE library_id = 1')
      .run()
    const second = await scanCoordinator.run({ libraryId: 1, trigger: 'manual' })
    assert.deepEqual(second.offlineFolders, [], JSON.stringify(second))
    assert.equal(second.deletedVideos >= 1, true, JSON.stringify(second))
    const afterSecond = getDb()
      .prepare(
        `SELECT video.code AS code
           FROM library_video_memberships membership
           JOIN videos video ON video.id = membership.video_id
          WHERE membership.library_id = 1
          ORDER BY video.code`
      )
      .all() as Array<{ code: string }>
    assert.deepEqual(
      afterSecond.map((row) => row.code),
      ['S13-M12']
    )
    assert.equal(readCatalogIdentity()?.frozen, false)
  })

  it('does not promote leftover staging files into formal covers after enable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s13-m14-'))
    roots.push(root)
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    const mappedMount = path.join(root, 'mount-mapped')
    const targetMount = path.join(root, 'mount-target')
    for (const dir of [sourceDir, targetDir, mappedMount, targetMount]) fs.mkdirSync(dir)
    const sourceImages = path.join(sourceDir, 'media_assets')
    const targetImages = path.join(targetDir, 'media_assets')
    fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
    fs.mkdirSync(path.join(sourceImages, 'uploads'), { recursive: true })
    fs.mkdirSync(targetImages, { recursive: true })
    const coverRel = 'covers/s13-m14.png'
    const orphanRel = 'uploads/orphan-staging.png'
    fs.writeFileSync(path.join(sourceImages, coverRel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
    fs.writeFileSync(path.join(sourceImages, orphanRel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x01]))

    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    const targetDb = openIsolatedCatalog(path.join(targetDir, 'library.db'))
    try {
      const sourceId = ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      ensureCatalogIdentity({ serverId: randomUUID() }, targetDb)
      const mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const localFile = path.join(mappedMount, 'S13-M14.mp4')
      fs.writeFileSync(localFile, 'video')
      const inserted = insertTestVideoWithFile(sourceDb, {
        code: 'S13-M14',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
      })
      sourceDb.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRel, inserted.videoId)
      const now = new Date().toISOString()
      sourceDb
        .prepare(
          `INSERT INTO catalog_image_uploads (
             upload_id, purpose, content_type, writer_epoch, catalog_id, status, rel_path,
             byte_length, created_at, expires_at, updated_at
           ) VALUES (?, 'videoCover', 'image/png', 0, ?, 'ready', ?, 7, ?, ?, ?)`
        )
        .run(randomUUID(), sourceId.catalogId, orphanRel, now, now, now)

      const sourceHost = {
        appVersion: '0.7.0',
        userDataPath: sourceDir,
        imagesDir: sourceImages,
        mediaMounts: { mapped: mappedMount }
      }
      const preview = previewCatalogMigration(
        { mappings: [{ sourceRootId: mappedRootId, targetMountSelectionId: 'mapped' }] },
        sourceHost,
        sourceDb
      )
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceHost,
        sourceDb
      )
      const targetHost = {
        appVersion: '0.7.0',
        userDataPath: targetDir,
        imagesDir: targetImages,
        mediaMounts: { mapped: targetMount }
      }
      const issued = issueCatalogMigrationToken({}, targetDb)
      authenticateMigration(issued.oneTimeToken, targetDb)
      stageMigrationPackageFile(preview.migrationId, migrationPackagePath(preview.migrationId, sourceHost), targetHost)
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      enableCatalogMigration(
        { confirmSourceStopped: true, migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
    } finally {
      sourceDb.close()
      targetDb.close()
    }

    assert.equal(fs.existsSync(path.join(targetImages, coverRel)), true)
    assert.equal(fs.existsSync(path.join(targetImages, orphanRel)), false)
    process.env.JAVDEX_TEST_USER_DATA = targetDir
    configureLibraryHost({
      userDataPath: () => targetDir,
      assets: { assetEncryption: () => false, mediaAssetsPath: () => targetImages },
      mediaMounts: () => ({ mapped: targetMount })
    })
    initDatabaseAtPath(path.join(targetDir, 'library.db'))
    const uploads = (
      getDb().prepare('SELECT COUNT(*) AS n FROM catalog_image_uploads').get() as { n: number }
    ).n
    assert.equal(uploads, 0)
    const cover = getDb().prepare("SELECT cover_path FROM videos WHERE code = 'S13-M14'").get() as {
      cover_path: string
    }
    assert.equal(cover.cover_path, coverRel)

    fs.mkdirSync(path.join(targetImages, 'uploads'), { recursive: true })
    fs.writeFileSync(path.join(targetImages, orphanRel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x02]))
    recoverCatalogImages(getDb())
    assert.equal(fs.existsSync(path.join(targetImages, orphanRel)), false)
    assert.equal(fs.existsSync(path.join(targetImages, coverRel)), true)
    const coverAfter = getDb().prepare("SELECT cover_path FROM videos WHERE code = 'S13-M14'").get() as {
      cover_path: string
    }
    assert.equal(coverAfter.cover_path, coverRel)
  })
})
