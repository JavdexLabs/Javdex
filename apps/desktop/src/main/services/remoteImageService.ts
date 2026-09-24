import { fetchRemoteImageBuffer, mimeTypeFromImageUrl } from './remoteImageFetch'
import type { RemoteImagePreviewResult } from '@shared/appIpcContract'

/** Download a remote image for preview in the import modal. */
export async function fetchRemoteImagePreview(url: string): Promise<RemoteImagePreviewResult> {
  const buf = await fetchRemoteImageBuffer(url)
  return {
    mimeType: mimeTypeFromImageUrl(url),
    dataBase64: buf.toString('base64')
  }
}
