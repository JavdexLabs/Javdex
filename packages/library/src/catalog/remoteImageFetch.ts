import path from 'node:path'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { fetchPublicHttpBuffer } from '@library/net/publicHttpFetch'
import { resolveLibraryScrapeProxyUrl } from '@library/runtime/host'

function isValidImageBuffer(buf: Buffer): boolean {
  return buf.length > 0 && mediaAssetStore.readImageDimensions(buf) != null
}

/**
 * Fetch a renderer-supplied image URL without allowing private-network access,
 * unbounded redirects, or unbounded response bodies.
 */
export async function fetchRemoteImageBuffer(url: string): Promise<Buffer> {
  const buf = await fetchPublicHttpBuffer(url, {
    proxyUrl: resolveLibraryScrapeProxyUrl()
  })
  if (!isValidImageBuffer(buf)) throw new Error('图片链接返回的内容不是有效图片')
  return buf
}

export const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}

export function mimeTypeFromImageUrl(url: string): string {
  const ext = path.extname(url.split('?')[0] ?? '').toLowerCase()
  return EXT_TO_MIME[ext] ?? 'image/jpeg'
}
