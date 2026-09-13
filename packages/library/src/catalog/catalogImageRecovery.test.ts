import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { ensureCatalogIdentity } from './catalogIdentity'
import {
  completeCatalogUploadFromBuffer,
  createCatalogUpload,
  insertImageFileJob,
  PENDING_SCRAPE_STAGING_DIRNAME
} from './catalogUploads'
import { applyPendingScrapeStagingRef, applyVideoCoverRef, commitManageImageMutation } from './catalogImageApply'
import { recoverCatalogImages } from './catalogImageRecovery'
import { listFormallyReferencedImagePaths } from './catalogImageRefs'
import { readVideoAggregateVersion } from './catalogVideoVersion'

let root: string | null = null

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 9, height: 7, channels: 3, background: { r: 11, g: 22, b: 33 } }
  })
    .png()
    .toBuffer()
}

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s06-recover-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'library.db'))
  return ensureCatalogIdentity({ catalogId: randomUUID() })
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('catalog image recovery', () => {
  it('never deletes a formally referenced cover and keeps pending scrape staging', async () => {
    const identity = setup()
    const videoId = Number(getDb().prepare("INSERT INTO videos (code, title) VALUES ('S06-R', 'R')").run().lastInsertRowid)
    const coverUpload = createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId
    })
    await completeCatalogUploadFromBuffer(coverUpload.uploadId, await png(), {
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      contentType: 'image/png'
    })
    const version = readVideoAggregateVersion(videoId)!
    commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'videos.setPoster',
        expectedVersions: { V: version },
        input: { videoId },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyVideoCoverRef(
          videoId,
          { kind: 'upload', uploadId: coverUpload.uploadId },
          { V: version },
          randomUUID()
        )
    )
    const cover = (
      getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as { cover_path: string }
    ).cover_path
    insertImageFileJob({ kind: 'deleteReplaced', relPath: cover })
    recoverCatalogImages(getDb())
    assert.equal(fs.existsSync(mediaAssetStore.resolve(cover)), true)
    assert.equal(listFormallyReferencedImagePaths(getDb()).has(cover), true)

    const pending = createCatalogUpload({
      purpose: 'pendingScrapeStaging',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId
    })
    await completeCatalogUploadFromBuffer(pending.uploadId, await png(), {
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      contentType: 'image/png'
    })
    const staged = applyPendingScrapeStagingRef(pending.uploadId, randomUUID())
    assert.ok(staged.stagedPath.startsWith(`${PENDING_SCRAPE_STAGING_DIRNAME}/`))
    recoverCatalogImages(getDb(), new Date(Date.now() + 48 * 60 * 60 * 1000))
    assert.equal(fs.existsSync(mediaAssetStore.resolve(staged.stagedPath)), true)
  })

  it('deletes leftover upload files that are not live uploads or formal covers', async () => {
    setup()
    const orphanRel = 'uploads/orphan-staging.png'
    fs.mkdirSync(path.dirname(mediaAssetStore.resolve(orphanRel)), { recursive: true })
    fs.writeFileSync(mediaAssetStore.resolve(orphanRel), await png())
    recoverCatalogImages(getDb())
    assert.equal(fs.existsSync(mediaAssetStore.resolve(orphanRel)), false)
  })
})
