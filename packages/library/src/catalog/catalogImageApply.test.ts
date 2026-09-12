import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { addVideoSampleAsset } from '@library/db/videoRepo'
import { assetsRoot, resolveAssetPath } from '@library/mediaAssetStore/filesystem'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { ensureCatalogIdentity } from './catalogIdentity'
import { completeCatalogUploadFromBuffer, createCatalogUpload, readCatalogUpload } from './catalogUploads'
import {
  applyActressAvatarRef,
  applyActressCropRef,
  applyActressGalleryRefs,
  applyClassificationImageRef,
  applyPendingScrapeStagingRef,
  applyPlaylistCoverRef,
  applyVideoCoverRef,
  applyVideoPosterRef,
  applyVideoSampleRefs,
  commitManageImageMutation
} from './catalogImageApply'
import { readActressAggregateVersion, readVideoAggregateVersion } from './catalogAggregateVersion'
import { PENDING_SCRAPE_STAGING_DIRNAME } from './catalogUploads'
import type { UploadPurpose } from '@shared/protocol/uploads'
import type { CatalogIdentityState } from './catalogIdentity'

let root: string | null = null
let identity: CatalogIdentityState

async function png(color = { r: 90, g: 20, b: 20 }): Promise<Buffer> {
  return sharp({
    create: { width: 16, height: 10, channels: 3, background: color }
  })
    .png()
    .toBuffer()
}

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s06-apply-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'library.db'))
  identity = ensureCatalogIdentity({ catalogId: randomUUID() })
}

async function readyUpload(purpose: UploadPurpose, color?: { r: number; g: number; b: number }) {
  const created = createCatalogUpload({
    purpose,
    contentType: 'image/png',
    writerEpoch: identity.writerEpoch,
    catalogId: identity.catalogId
  })
  await completeCatalogUploadFromBuffer(created.uploadId, await png(color), {
    writerEpoch: identity.writerEpoch,
    catalogId: identity.catalogId,
    contentType: 'image/png'
  })
  return created.uploadId
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('catalog image apply', () => {
  it('applies cover, samples, poster-from-sample, actress, classification, playlist, and pending scrape images', async () => {
    setup()
    const videoId = Number(getDb().prepare("INSERT INTO videos (code, title) VALUES ('S06-001', 'One')").run().lastInsertRowid)
    const otherId = Number(getDb().prepare("INSERT INTO videos (code, title) VALUES ('S06-002', 'Two')").run().lastInsertRowid)
    const actressId = Number(getDb().prepare("INSERT INTO actresses (main_name) VALUES ('S06 Actress')").run().lastInsertRowid)
    const orgId = Number(getDb().prepare("INSERT INTO organizations (main_name) VALUES ('S06 Org')").run().lastInsertRowid)
    const coverUpload = await readyUpload('videoCover', { r: 200, g: 10, b: 10 })
    const sampleUpload = await readyUpload('videoSample', { r: 10, g: 200, b: 10 })
    const version = readVideoAggregateVersion(videoId)!
    const cover = commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'videos.edit',
        expectedVersions: { V: version },
        input: { videoId, coverUpload },
        writerEpoch: identity.writerEpoch
      },
      () => applyVideoCoverRef(videoId, { kind: 'upload', uploadId: coverUpload }, { V: version }, randomUUID())
    )
    assert.equal(cover.outcome, 'applied')
    const coverPath = (getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as { cover_path: string }).cover_path
    assert.ok(coverPath.startsWith('covers/'))
    assert.equal(fs.existsSync(resolveAssetPath(coverPath)), true)
    assert.equal(readCatalogUpload(coverUpload)?.status, 'consumed')

    const afterCover = readVideoAggregateVersion(videoId)!
    const samples = commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'videos.importSamples',
        expectedVersions: { V: afterCover },
        input: { videoId, sampleUpload },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyVideoSampleRefs(
          videoId,
          [{ kind: 'upload', uploadId: sampleUpload }],
          { V: afterCover },
          randomUUID()
        )
    )
    const sampleAssetId = samples.data.assetIds[0]
    const afterSamples = readVideoAggregateVersion(videoId)!
    const poster = commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'videos.setPoster',
        expectedVersions: { V: afterSamples },
        input: { videoId, sampleAssetId },
        writerEpoch: identity.writerEpoch
      },
      () => applyVideoPosterRef(videoId, { kind: 'asset', assetId: sampleAssetId }, { V: afterSamples }, randomUUID())
    )
    assert.ok(poster.data.posterPath)

    const otherSampleRel = mediaAssetStore.importSampleFromBuffer('S06-002', await png({ r: 1, g: 1, b: 1 }))
    const foreign = addVideoSampleAsset(otherId, { localPath: otherSampleRel })
    const currentV = { V: readVideoAggregateVersion(videoId)! }
    assert.throws(
      () => applyVideoPosterRef(videoId, { kind: 'asset', assetId: foreign.id }, currentV, randomUUID()),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    assert.throws(
      () => applyVideoCoverRef(videoId, { kind: 'asset', assetId: foreign.id }, currentV, randomUUID()),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    const unchanged = (getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as { cover_path: string }).cover_path
    assert.equal(unchanged, coverPath)

    const actressVersion = readActressAggregateVersion(actressId)!
    const avatarUpload = await readyUpload('actressAvatar', { r: 20, g: 20, b: 200 })
    commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'actresses.setPoster',
        expectedVersions: { A: actressVersion },
        input: { actressId, avatarUpload },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyActressAvatarRef(actressId, { kind: 'upload', uploadId: avatarUpload }, { A: actressVersion }, randomUUID())
    )
    const avatar = getDb()
      .prepare('SELECT avatar_path, avatar_source_path FROM actresses WHERE id = ?')
      .get(actressId) as { avatar_path: string; avatar_source_path: string }
    assert.ok(avatar.avatar_path)
    assert.ok(avatar.avatar_source_path)
    const afterAvatar = readActressAggregateVersion(actressId)!
    const galleryUpload = await readyUpload('actressGallery')
    commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'actresses.importGallery',
        expectedVersions: { A: afterAvatar },
        input: { actressId, galleryUpload },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyActressGalleryRefs(
          actressId,
          [{ kind: 'upload', uploadId: galleryUpload }],
          { A: afterAvatar },
          randomUUID()
        )
    )
    const sourceDigest = createHash('sha256')
      .update(mediaAssetStore.readBytes(avatar.avatar_source_path))
      .digest('hex')
    const cropUpload = await readyUpload('actressAvatar', { r: 9, g: 9, b: 9 })
    const afterGallery = readActressAggregateVersion(actressId)!
    commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'actresses.applyCrop',
        expectedVersions: { A: afterGallery },
        input: { actressId },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyActressCropRef(
          {
            actressId,
            sourceAssetId: actressId,
            sourceDigest,
            sourceVersion: String(afterGallery.revision),
            image: { kind: 'upload', uploadId: cropUpload }
          },
          { A: afterGallery },
          randomUUID()
        )
    )

    const classUpload = await readyUpload('classificationImage')
    const orgVersion = getDb()
      .prepare('SELECT generation, revision FROM organizations WHERE id = ?')
      .get(orgId) as { generation: number; revision: number }
    commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'classificationImages.set',
        expectedVersions: { F: orgVersion },
        input: { orgId, classUpload },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyClassificationImageRef(
          { kind: 'organization', id: orgId },
          { kind: 'upload', uploadId: classUpload },
          { F: orgVersion },
          randomUUID()
        )
    )
    const orgImage = (getDb().prepare('SELECT image_path FROM organizations WHERE id = ?').get(orgId) as { image_path: string }).image_path
    assert.ok(orgImage)

    const playlistUpload = await readyUpload('playlistCover')
    const playlist = commitManageImageMutation(
      {
        operationId: randomUUID(),
        operation: 'playlists.create',
        expectedVersions: {},
        input: { name: 'S06 list' },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyPlaylistCoverRef(
          null,
          { kind: 'upload', uploadId: playlistUpload },
          { name: 'S06 list' },
          {},
          randomUUID()
        )
    )
    const playlistCover = (
      getDb().prepare('SELECT cover_path FROM playlists WHERE id = ?').get(playlist.data.playlistId) as {
        cover_path: string
      }
    ).cover_path
    assert.ok(playlistCover)

    const pendingUpload = await readyUpload('pendingScrapeStaging')
    const staged = applyPendingScrapeStagingRef(pendingUpload, randomUUID())
    assert.ok(staged.stagedPath.startsWith(`${PENDING_SCRAPE_STAGING_DIRNAME}/`))
    assert.equal(fs.existsSync(resolveAssetPath(staged.stagedPath)), true)
    assert.ok(assetsRoot().includes(root!))
  })
})
