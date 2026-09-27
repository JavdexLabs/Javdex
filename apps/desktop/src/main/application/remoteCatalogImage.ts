import { readFile, stat } from 'node:fs/promises'
import { inspectServedImage } from '@library/mediaAssetStore'
import type { UploadPurpose, CatalogImageRef } from '@shared/protocol/uploads'
import { UPLOAD_STREAM_MAX_BYTES } from '@shared/protocol/limits'
import type { CatalogBackend } from './catalogBackend'
import { ipcMutation } from './mutationContext'
import { fetchRemoteImageBuffer } from '../services/remoteImageFetch'

export type RemoteImageSource =
  | { source: 'file'; sourcePath?: string | null; remoteUrl?: string | null }
  | { source: 'url'; sourcePath?: string | null; remoteUrl?: string | null }

// Keep the desktop-side guard in lockstep with the server upload contract so
// oversized local files fail before creating an upload slot.
const MAX_IMAGE_BYTES = UPLOAD_STREAM_MAX_BYTES

export async function uploadCatalogImage(
  backend: CatalogBackend,
  purpose: UploadPurpose,
  body: Buffer
): Promise<CatalogImageRef> {
  const contentType = await inspectServedImage(body)
  const upload = await backend.assets.createUpload({ purpose, contentType }, ipcMutation())
  await backend.assets.putUpload({ uploadId: upload.uploadId, body, contentType })
  return { kind: 'upload', uploadId: upload.uploadId }
}

export async function uploadCatalogImageSource(
  backend: CatalogBackend,
  purpose: UploadPurpose,
  input: RemoteImageSource
): Promise<CatalogImageRef> {
  let body: Buffer
  if (input.source === 'file') {
    if (!input.sourcePath) throw new Error('缺少图片文件路径')
    const file = await stat(input.sourcePath)
    if (!file.isFile() || file.size > MAX_IMAGE_BYTES) throw new Error('图片文件无效或超过 32 MB')
    body = await readFile(input.sourcePath)
  } else {
    if (!input.remoteUrl) throw new Error('缺少图片地址')
    body = await fetchRemoteImageBuffer(input.remoteUrl)
  }
  return uploadCatalogImage(backend, purpose, body)
}

export async function uploadCatalogImageBase64(
  backend: CatalogBackend,
  purpose: UploadPurpose,
  encoded: string
): Promise<CatalogImageRef> {
  const body = Buffer.from(encoded, 'base64')
  if (body.length === 0 || body.length > MAX_IMAGE_BYTES) throw new Error('图片内容无效或超过 32 MB')
  return uploadCatalogImage(backend, purpose, body)
}
