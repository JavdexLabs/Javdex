import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import type { CatalogBackend } from './catalogBackend'
import { remoteClassificationImage } from './remoteClassificationImage'

let directory: string | undefined
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined })

it('uploads a selected local classification image before sending a server image reference', async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'javdex-classification-upload-'))
  const file = path.join(directory, 'cover.png')
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#58a0b5' } }).png().toBuffer()
  writeFileSync(file, image)
  let uploaded: Buffer | undefined
  const backend = {
    assets: {
      createUpload: async (input: { purpose: string; contentType: string }) => {
        assert.deepEqual(input, { purpose: 'classificationImage', contentType: 'image/png' })
        return { uploadId: 'test-upload' }
      },
      putUpload: async (input: { uploadId: string; body: Buffer; contentType: string }) => {
        assert.equal(input.uploadId, 'test-upload')
        assert.equal(input.contentType, 'image/png')
        uploaded = input.body
      }
    }
  } as unknown as CatalogBackend
  assert.deepEqual(await remoteClassificationImage(backend, { source: 'file', sourcePath: file }), {
    kind: 'upload', uploadId: 'test-upload'
  })
  assert.deepEqual(uploaded, image)
  assert.deepEqual(await remoteClassificationImage(backend, { source: 'video-cover', videoId: 7 }), {
    kind: 'videoCover', videoId: 7
  })
  assert.deepEqual(await remoteClassificationImage(backend, null), { kind: 'clear' })
})
