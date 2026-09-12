import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { resolveAssetPath } from '@library/mediaAssetStore/filesystem'
import { ensureCatalogIdentity, type CatalogIdentityState } from './catalogIdentity'
import {
  completeCatalogUploadFromBuffer,
  createCatalogUpload,
  findReadyUploadRelOnDisk,
  readCatalogUpload
} from './catalogUploads'
import { recoverCatalogImages } from './catalogImageRecovery'
import type { ImageCrashPoint } from './catalogImageCrash'

let root: string | null = null

async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 4, g: 5, b: 6 } }
  })
    .png()
    .toBuffer()
}

function setup(): CatalogIdentityState {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s06-crash-'))
  process.env.JAVDEX_TEST_USER_DATA = root
  initDatabaseAtPath(path.join(root, 'library.db'))
  return ensureCatalogIdentity({ catalogId: randomUUID() })
}

function reopen(): void {
  closeDatabase()
  initDatabaseAtPath(path.join(root!, 'library.db'))
}

function spawnCrash(env: Record<string, string>): { status: number | null; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      '--require',
      path.resolve('scripts/register-test-paths.cjs'),
      '--import',
      'tsx',
      '--import',
      path.resolve('scripts/register-library-test-host.ts'),
      path.resolve('packages/library/src/catalog/catalogImageCrashChild.ts')
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        JAVDEX_IMAGE_CRASH_CHILD: '1',
        JAVDEX_TEST_USER_DATA: root!,
        ...env
      }
    }
  )
  return { status: result.status, stderr: `${result.stderr ?? ''}${result.stdout ?? ''}` }
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
  delete process.env.JAVDEX_TEST_USER_DATA
})

describe('catalog image crash recovery', () => {
  it('keeps a persisted upload row after afterPersistUploadRow', () => {
    setup()
    const uploadId = randomUUID()
    closeDatabase()
    const crashed = spawnCrash({
      JAVDEX_CRASH_SCENARIO: 'createSlot',
      JAVDEX_CRASH_UPLOAD_ID: uploadId,
      JAVDEX_IMAGE_CRASH: 'afterPersistUploadRow'
    })
    assert.equal(crashed.status, 75, crashed.stderr)
    reopen()
    assert.equal(readCatalogUpload(uploadId)?.status, 'reserved')
  })

  it('fails an interrupted write and recovers a write that finished on disk', async () => {
    const identity = setup()
    const failedId = randomUUID()
    createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      uploadId: failedId
    })
    closeDatabase()
    const beforeWrite = spawnCrash({
      JAVDEX_CRASH_SCENARIO: 'uploadWrite',
      JAVDEX_CRASH_UPLOAD_ID: failedId,
      JAVDEX_IMAGE_CRASH: 'beforeWriteFile'
    })
    assert.equal(beforeWrite.status, 75, beforeWrite.stderr)
    reopen()
    recoverCatalogImages(getDb())
    assert.equal(readCatalogUpload(failedId)?.status, 'failed')

    const readyId = randomUUID()
    createCatalogUpload({
      purpose: 'videoCover',
      contentType: 'image/png',
      writerEpoch: identity.writerEpoch,
      catalogId: identity.catalogId,
      uploadId: readyId
    })
    closeDatabase()
    const afterWrite = spawnCrash({
      JAVDEX_CRASH_SCENARIO: 'uploadWrite',
      JAVDEX_CRASH_UPLOAD_ID: readyId,
      JAVDEX_IMAGE_CRASH: 'afterWriteFile'
    })
    assert.equal(afterWrite.status, 75, afterWrite.stderr)
    reopen()
    recoverCatalogImages(getDb())
    const recovered = readCatalogUpload(readyId)
    assert.equal(recovered?.status, 'ready')
    assert.ok(recovered.relPath || findReadyUploadRelOnDisk(readyId))
  })

  it('does not lose the live formal cover if apply crashes before the ref commit', async () => {
    const identity = setup()
    const videoId = Number(
      getDb().prepare("INSERT INTO videos (code, title) VALUES ('S06-CRASH', 'Keep')").run().lastInsertRowid
    )
    const originalRel = 'covers/original-keep.png'
    fs.mkdirSync(path.join(root!, 'media_assets', 'covers'), { recursive: true })
    fs.writeFileSync(path.join(root!, 'media_assets', originalRel), await png())
    getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(originalRel, videoId)

    for (const point of ['beforeWriteFile', 'afterWriteFile', 'beforeRefCommit'] as ImageCrashPoint[]) {
      const uploadId = randomUUID()
      createCatalogUpload({
        purpose: 'videoCover',
        contentType: 'image/png',
        writerEpoch: identity.writerEpoch,
        catalogId: identity.catalogId,
        uploadId
      })
      await completeCatalogUploadFromBuffer(uploadId, await png(), {
        writerEpoch: identity.writerEpoch,
        catalogId: identity.catalogId,
        contentType: 'image/png'
      })
      closeDatabase()
      const apply = spawnCrash({
        JAVDEX_CRASH_SCENARIO: 'applyCover',
        JAVDEX_CRASH_UPLOAD_ID: uploadId,
        JAVDEX_CRASH_VIDEO_ID: String(videoId),
        JAVDEX_CRASH_OPERATION_ID: randomUUID(),
        JAVDEX_IMAGE_CRASH: point
      })
      assert.equal(apply.status, 75, `${point}: ${apply.stderr}`)
      reopen()
      recoverCatalogImages(getDb())
      const cover = getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as {
        cover_path: string
      }
      assert.equal(cover.cover_path, originalRel, point)
      assert.equal(fs.existsSync(path.join(root!, 'media_assets', originalRel)), true, point)
    }
  })

  it('keeps the newly referenced cover if apply crashes after the ref commit', async () => {
    const identity = setup()
    const videoId = Number(
      getDb().prepare("INSERT INTO videos (code, title) VALUES ('S06-NEW', 'New')").run().lastInsertRowid
    )
    const originalRel = 'covers/old-cover.png'
    fs.mkdirSync(path.join(root!, 'media_assets', 'covers'), { recursive: true })
    fs.writeFileSync(path.join(root!, 'media_assets', originalRel), await png())
    getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(originalRel, videoId)

    for (const point of ['afterRefCommit', 'beforeOldDelete', 'afterOldDelete'] as ImageCrashPoint[]) {
      const uploadId = randomUUID()
      createCatalogUpload({
        purpose: 'videoCover',
        contentType: 'image/png',
        writerEpoch: identity.writerEpoch,
        catalogId: identity.catalogId,
        uploadId
      })
      await completeCatalogUploadFromBuffer(uploadId, await png(), {
        writerEpoch: identity.writerEpoch,
        catalogId: identity.catalogId,
        contentType: 'image/png'
      })
      const previous = (
        getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as { cover_path: string }
      ).cover_path
      closeDatabase()
      const apply = spawnCrash({
        JAVDEX_CRASH_SCENARIO: 'applyCover',
        JAVDEX_CRASH_UPLOAD_ID: uploadId,
        JAVDEX_CRASH_VIDEO_ID: String(videoId),
        JAVDEX_CRASH_OPERATION_ID: randomUUID(),
        JAVDEX_IMAGE_CRASH: point
      })
      assert.equal(apply.status, 75, `${point}: ${apply.stderr}`)
      reopen()
      recoverCatalogImages(getDb())
      const cover = getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as {
        cover_path: string
      }
      assert.notEqual(cover.cover_path, previous, point)
      assert.equal(fs.existsSync(resolveAssetPath(cover.cover_path)), true, point)
    }
  })
})
