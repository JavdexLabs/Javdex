import { randomUUID } from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { readCatalogIdentity } from './catalogIdentity'
import {
  completeCatalogUploadFromBuffer,
  createCatalogUpload
} from './catalogUploads'
import { applyVideoCoverRef, commitManageImageMutation } from './catalogImageApply'
import { readVideoAggregateVersion } from './catalogVideoVersion'

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 8, channels: 3, background: { r: 40, g: 80, b: 120 } }
  })
    .png()
    .toBuffer()
}

async function main(): Promise<void> {
  const root = process.env.JAVDEX_TEST_USER_DATA
  if (!root) throw new Error('JAVDEX_TEST_USER_DATA required')
  initDatabaseAtPath(path.join(root, 'library.db'))
  const identity = readCatalogIdentity()
  if (!identity) throw new Error('catalog identity missing')
  const scenario = process.env.JAVDEX_CRASH_SCENARIO
  const uploadId = process.env.JAVDEX_CRASH_UPLOAD_ID
  const videoId = Number(process.env.JAVDEX_CRASH_VIDEO_ID ?? '0')
  const operationId = process.env.JAVDEX_CRASH_OPERATION_ID ?? randomUUID()
  if (scenario === 'createSlot') {
    createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      uploadId: uploadId ?? randomUUID()
    })
    return
  }
  if (scenario === 'uploadWrite') {
    if (!uploadId) throw new Error('upload id required')
    await completeCatalogUploadFromBuffer(
      uploadId,
      await png(),
      {
        writerEpoch: identity.writerEpoch,
        catalogId: identity.catalogId,
        contentType: 'image/png'
      }
    )
    return
  }
  if (scenario === 'applyCover') {
    if (!uploadId || !videoId) throw new Error('applyCover requires upload and video')
    const version = readVideoAggregateVersion(videoId, getDb())
    if (!version) throw new Error('video missing')
    commitManageImageMutation(
      {
        operationId,
        operation: 'videos.setPoster',
        expectedVersions: { V: version },
        input: { videoId, uploadId },
        writerEpoch: identity.writerEpoch
      },
      () =>
        applyVideoCoverRef(
          videoId,
          { kind: 'upload', uploadId },
          { V: version },
          operationId,
          getDb()
        )
    )
    return
  }
  throw new Error(`unknown crash scenario: ${scenario}`)
}

if (process.env.JAVDEX_IMAGE_CRASH_CHILD === '1') {
  main()
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
    .finally(() => {
      try {
        closeDatabase()
      } catch {
        // Crash points exit before this runs.
      }
    })
}
