import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { UPLOAD_STREAM_MAX_BYTES, UPLOAD_TTL_MS } from '@shared/protocol/limits'
import { ensureCatalogIdentity } from './catalogIdentity'
import {
  completeCatalogUploadFromBuffer,
  createCatalogUpload,
  inspectCatalogUpload,
  readCatalogUpload,
  UPLOAD_DIRNAME
} from './catalogUploads'
import { recoverCatalogImages } from './catalogImageRecovery'
import { mediaAssetStore } from '@library/mediaAssetStore'

let root: string | null = null

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 10, height: 6, channels: 3, background: { r: 12, g: 24, b: 36 } }
  })
    .png()
    .toBuffer()
}

function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s06-uploads-'))
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

describe('catalog image uploads', () => {
  it('persists the slot before bytes, then inspects a completed stream', async () => {
    const identity = setup()
    const created = createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId
    })
    const row = readCatalogUpload(created.uploadId)!
    assert.equal(row.status, 'reserved')
    assert.equal(row.relPath, `${UPLOAD_DIRNAME}/${created.uploadId}.part`)
    assert.equal(created.maxBytes, UPLOAD_STREAM_MAX_BYTES)
    const bytes = await png()
    const inspected = await completeCatalogUploadFromBuffer(created.uploadId, bytes, {
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      contentType: 'image/png'
    })
    assert.equal(inspected.consumed, false)
    assert.equal(inspected.byteLength, bytes.length)
    assert.equal(inspected.width, 10)
    assert.equal(inspected.height, 6)
    assert.equal(inspectCatalogUpload(created.uploadId).sha256, inspected.sha256)
    assert.equal(readCatalogUpload(created.uploadId)?.status, 'ready')
  })

  it('rejects bytes that do not match the reserved content type', async () => {
    const identity = setup()
    const created = createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId
    })
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .jpeg()
      .toBuffer()
    await assert.rejects(
      () =>
        completeCatalogUploadFromBuffer(created.uploadId, jpeg, {
          writerEpoch: identity.writerEpoch,
          catalogId: identity.catalogId,
          contentType: 'image/png'
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    assert.equal(readCatalogUpload(created.uploadId)?.status, 'failed')
  })

  it('expires unconsumed uploads and does not treat completion as business apply', async () => {
    const identity = setup()
    const created = createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      now: new Date(Date.now() - UPLOAD_TTL_MS - 1000)
    })
    assert.equal(UPLOAD_TTL_MS, 24 * 60 * 60 * 1000)
    recoverCatalogImages(getDb())
    const row = readCatalogUpload(created.uploadId)!
    assert.ok(row.status === 'discarding' || row.status === 'expired')
    const abs = path.join(mediaAssetStore.rootPath(), row.relPath ?? `${UPLOAD_DIRNAME}/${created.uploadId}.part`)
    assert.equal(fs.existsSync(abs), false)
  })
})
