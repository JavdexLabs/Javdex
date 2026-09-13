import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { isStructuredError } from '@shared/protocol/errors'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { configureLibraryHost, resetLibraryHostForTests } from '@library/runtime/host'
import { ensureCatalogIdentity, readCatalogIdentity } from './catalogIdentity'
import { issueCatalogMigrationToken, authenticateMigration } from './catalogMigrationAuth'
import {
  abandonCatalogMigration,
  allowEnableCatalogMigration,
  enableCatalogMigration,
  openIsolatedCatalog,
  previewCatalogMigration,
  stageMigrationPackageFile,
  startCatalogMigration,
  statusCatalogMigration,
  migrationPackagePath
} from './catalogMigration'
import { buildVideoResourceSourceIdentity } from '@library/videoResourceIdentity'

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

describe('catalogMigration protocol', () => {
  const roots: string[] = []
  afterEach(() => {
    resetLibraryHostForTests()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('previews unmapped STRM conversion, rejects mapping errors, and round-trips into an empty target', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s12-mig-'))
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
    fs.mkdirSync(path.join(targetImages, 'covers'), { recursive: true })
    const coverRel = 'covers/s12.png'
    fs.writeFileSync(path.join(sourceImages, coverRel), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))

    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    const targetDb = openIsolatedCatalog(path.join(targetDir, 'library.db'))
    try {
      const sourceId = ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      const targetId = ensureCatalogIdentity({ serverId: randomUUID() }, targetDb)
      assert.ok(sourceId.serverId)
      assert.ok(targetId.serverId)

      const mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const unmappedRootId = insertRoot(sourceDb, 1, unmappedMount)
      sourceDb
        .prepare('UPDATE media_library_configs SET remove_resource_less_memberships = 1 WHERE library_id = 1')
        .run()
      const localFile = path.join(mappedMount, 'S12-001.mp4')
      fs.writeFileSync(localFile, 'video')
      const inserted = insertTestVideoWithFile(sourceDb, {
        code: 'S12-001',
        title: 'Source clip',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
      })
      sourceDb.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRel, inserted.videoId)
      const strmPath = path.join(unmappedMount, 'S12-001.strm')
      fs.writeFileSync(strmPath, 'https://example.test/S12-001.mp4')
      const strmIdentity = buildVideoResourceSourceIdentity({
        kind: 'direct',
        locator: 'https://example.test/S12-001.mp4',
        strmSourcePath: strmPath
      })
      sourceDb
        .prepare(
          `INSERT INTO video_resources (
             library_id, video_id, root_id, kind, locator, resource_key, source_identity,
             strm_source_path, is_primary, add_time
           ) VALUES (?, ?, ?, 'direct', ?, ?, ?, ?, 0, ?)`
        )
        .run(
          1,
          inserted.videoId,
          unmappedRootId,
          'https://example.test/S12-001.mp4',
          `strm:${strmPath}`,
          strmIdentity,
          strmPath,
          new Date().toISOString()
        )
      const unmappedOnlyFile = path.join(unmappedMount, 'S12-ORPHAN.mp4')
      fs.writeFileSync(unmappedOnlyFile, 'orphan')
      insertTestVideoWithFile(sourceDb, {
        code: 'S12-ORPHAN',
        title: 'Unmapped only',
        filePath: unmappedOnlyFile,
        libraryId: 1,
        rootId: unmappedRootId
      })
      sourceDb
        .prepare(
          `INSERT INTO catalog_writer_credentials (
             writer_epoch, secret_digest, claim_id, created_at
           ) VALUES (1, ?, ?, ?)`
        )
        .run('a'.repeat(64), randomUUID(), new Date().toISOString())

      const sourceHost = {
        appVersion: '0.7.0',
        userDataPath: sourceDir,
        imagesDir: sourceImages,
        mediaMounts: { mapped: mappedMount, unmapped: unmappedMount }
      }
      assert.throws(
        () =>
          previewCatalogMigration(
            { mappings: [{ sourceRootId: 999, targetMountSelectionId: 'mapped' }] },
            sourceHost,
            sourceDb
          ),
        (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
      )
      const preview = previewCatalogMigration(
        { mappings: [{ sourceRootId: mappedRootId, targetMountSelectionId: 'mapped' }] },
        sourceHost,
        sourceDb
      )
      assert.equal(preview.strmConversions, 1)
      assert.equal(preview.localResourceRemovals, 1)
      assert.equal(preview.omittedRoots.length, 1)
      assert.equal(preview.omittedRoots[0]?.rootId, unmappedRootId)
      assert.deepEqual(preview.autoCleanupDisabledLibraryIds, [1])
      assert.deepEqual(preview.pendingBlockers, [])

      const started = await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceHost,
        sourceDb
      )
      assert.equal((started as { state?: string }).state, 'succeeded')
      assert.equal(readCatalogIdentity(sourceDb)?.frozen, true)
      const pkg = migrationPackagePath(preview.migrationId, sourceHost)
      assert.equal(fs.existsSync(pkg), true)
      const allowed = allowEnableCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceDb
      )
      assert.equal(allowed.sourcePhase, 'enableAuthorized')

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
      stageMigrationPackageFile(preview.migrationId, pkg, targetHost)
      const imported = await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      assert.equal((imported as { state?: string }).state, 'succeeded')
      const enabled = enableCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      assert.equal(enabled.targetPhase, 'enabled')
      const newIdentity = readCatalogIdentity(targetDb)
      assert.ok(newIdentity)
      assert.notEqual(newIdentity.catalogId, sourceId.catalogId)
      assert.equal(newIdentity.serverId, targetId.serverId)
      assert.equal(newIdentity.frozen, false)
      assert.equal(newIdentity.writerEpoch, 0)
      const videos = targetDb.prepare('SELECT code, cover_path FROM videos ORDER BY code').all() as Array<{
        code: string
        cover_path: string | null
      }>
      assert.equal(videos.length, 2)
      assert.equal(videos[0]?.code, 'S12-001')
      assert.equal(videos[0]?.cover_path, coverRel)
      assert.equal(videos[1]?.code, 'S12-ORPHAN')
      assert.equal(fs.existsSync(path.join(targetImages, coverRel)), true)
      const cleanup = targetDb
        .prepare('SELECT remove_resource_less_memberships AS flag FROM media_library_configs WHERE library_id = 1')
        .get() as { flag: number }
      assert.equal(cleanup.flag, 0)
      const resources = targetDb
        .prepare('SELECT kind, strm_source_path, root_id FROM video_resources ORDER BY kind')
        .all() as Array<{ kind: string; strm_source_path: string | null; root_id: number | null }>
      assert.equal(resources.length, 2)
      const strm = resources.find((row) => row.kind === 'direct')
      assert.equal(strm?.strm_source_path, null)
      const creds = (
        targetDb.prepare('SELECT COUNT(*) AS n FROM catalog_writer_credentials').get() as { n: number }
      ).n
      assert.equal(creds, 0)
      const rootsOnTarget = (
        targetDb.prepare('SELECT COUNT(*) AS n FROM media_library_roots').get() as { n: number }
      ).n
      assert.equal(rootsOnTarget, 1)
      const sourceStillFrozen = readCatalogIdentity(sourceDb)
      assert.equal(sourceStillFrozen?.frozen, true)
      const mappedLocal = targetDb
        .prepare("SELECT locator FROM video_resources WHERE kind = 'local'")
        .get() as { locator: string }
      assert.equal(mappedLocal.locator.startsWith(targetMount), true)
    } finally {
      sourceDb.close()
      targetDb.close()
    }
  })

  it('serializes target enable versus abandon and rejects late enable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s12-race-'))
    roots.push(root)
    const sourceDir = path.join(root, 'source')
    const targetDir = path.join(root, 'target')
    const mappedMount = path.join(root, 'mount-mapped')
    const targetMount = path.join(root, 'mount-target')
    for (const dir of [sourceDir, targetDir, mappedMount, targetMount]) fs.mkdirSync(dir)
    const sourceImages = path.join(sourceDir, 'media_assets')
    const targetImages = path.join(targetDir, 'media_assets')
    fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
    fs.mkdirSync(targetImages, { recursive: true })
    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    const targetDb = openIsolatedCatalog(path.join(targetDir, 'library.db'))
    try {
      ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      ensureCatalogIdentity({ serverId: randomUUID() }, targetDb)
      const mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const localFile = path.join(mappedMount, 'S12-002.mp4')
      fs.writeFileSync(localFile, 'video')
      insertTestVideoWithFile(sourceDb, {
        code: 'S12-002',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
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
      stageMigrationPackageFile(
        preview.migrationId,
        migrationPackagePath(preview.migrationId, sourceHost),
        targetHost
      )
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      const abandoned = abandonCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        targetHost,
        targetDb
      )
      assert.equal(abandoned.targetPhase, 'abandoned')
      assert.throws(
        () =>
          enableCatalogMigration(
            { migrationId: preview.migrationId, digest: preview.digest },
            targetHost,
            targetDb
          ),
        (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'
      )
      const status = statusCatalogMigration({ migrationId: preview.migrationId }, targetDb)
      assert.equal(status.targetPhase, 'abandoned')
    } finally {
      sourceDb.close()
      targetDb.close()
    }
  })

  it('lets the source coordinator abandon a frozen catalog that never enabled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s12-abandon-src-'))
    roots.push(root)
    const sourceDir = path.join(root, 'source')
    const mappedMount = path.join(root, 'mount-mapped')
    for (const dir of [sourceDir, mappedMount]) fs.mkdirSync(dir)
    const sourceImages = path.join(sourceDir, 'media_assets')
    fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    try {
      ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      const mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const localFile = path.join(mappedMount, 'S12-003.mp4')
      fs.writeFileSync(localFile, 'video')
      insertTestVideoWithFile(sourceDb, {
        code: 'S12-003',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
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
      await startCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceHost,
        sourceDb
      )
      assert.equal(readCatalogIdentity(sourceDb)?.frozen, true)
      const abandoned = abandonCatalogMigration(
        { migrationId: preview.migrationId, digest: preview.digest },
        sourceHost,
        sourceDb
      )
      assert.equal(abandoned.sourcePhase, 'abandoned')
      assert.equal(readCatalogIdentity(sourceDb)?.frozen, false)
    } finally {
      sourceDb.close()
    }
  })

  it('records pending scrape and encrypted-asset blockers instead of freezing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s12-block-'))
    roots.push(root)
    const sourceDir = path.join(root, 'source')
    const mappedMount = path.join(root, 'mount-mapped')
    for (const dir of [sourceDir, mappedMount]) fs.mkdirSync(dir)
    const sourceImages = path.join(sourceDir, 'media_assets')
    fs.mkdirSync(path.join(sourceImages, 'covers'), { recursive: true })
    fs.writeFileSync(path.join(sourceImages, 'covers', 'enc.bin'), Buffer.from('AVPK\x01rest'))
    const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
    try {
      ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
      const mappedRootId = insertRoot(sourceDb, 1, mappedMount)
      const localFile = path.join(mappedMount, 'S12-004.mp4')
      fs.writeFileSync(localFile, 'video')
      const inserted = insertTestVideoWithFile(sourceDb, {
        code: 'S12-004',
        filePath: localFile,
        libraryId: 1,
        rootId: mappedRootId
      })
      const now = new Date().toISOString()
      sourceDb
        .prepare(
          `INSERT INTO pending_video_scrapes (
             video_id, revision, selected_fields_json, applicable_fields_json,
             update_mode, request_json, warnings_json, created_at, updated_at
           ) VALUES (?, 1, '[]', '[]', 'replace', '{}', '[]', ?, ?)`
        )
        .run(inserted.videoId, now, now)
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
      assert.ok(preview.pendingBlockers.includes('pending-video-scrapes'))
      assert.ok(preview.pendingBlockers.includes('encrypted-assets'))
      await assert.rejects(
        () =>
          startCatalogMigration(
            { migrationId: preview.migrationId, digest: preview.digest },
            sourceHost,
            sourceDb
          ),
        (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
      )
      assert.equal(readCatalogIdentity(sourceDb)?.frozen, false)
    } finally {
      sourceDb.close()
    }
  })
})
