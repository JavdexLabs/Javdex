import path from 'node:path'
import type { ImageThumbnailSize } from '@shared/imageVariants'
import { isStructuredError, structuredError } from '@shared/protocol/errors'
import {
  AssetPixelLimitError,
  AssetReadQueueFullError,
  AssetReadTooLargeError,
  mediaAssetStore
} from '@library/mediaAssetStore'
import { PENDING_SCRAPE_STAGING_DIRNAME, UPLOAD_DIRNAME } from './catalogUploads'

const ALLOWED_PREFIXES = new Set([
  'covers',
  'avatars',
  'actress_gallery',
  'samples',
  'playlist_covers',
  UPLOAD_DIRNAME,
  PENDING_SCRAPE_STAGING_DIRNAME,
  '.video_scrape_staging',
  '.actress_scrape_staging'
])

const DOT_DOT_SEGMENT = /(?:^|[\\/])(?:\.|%2e)(?:\.|%2e)(?=$|[\\/])/i

export function normalizeManageImageRelPath(relPath: string): string {
  const trimmed = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed || DOT_DOT_SEGMENT.test(trimmed) || trimmed.includes('\0')) {
    throw structuredError('INVALID_INPUT', '图片路径无效', { field: 'path' })
  }
  const normalized = path.posix.normalize(trimmed)
  if (!normalized || normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    throw structuredError('INVALID_INPUT', '图片路径无效', { field: 'path' })
  }
  const prefix = normalized.split('/')[0] ?? ''
  if (!ALLOWED_PREFIXES.has(prefix)) {
    throw structuredError('INVALID_INPUT', '图片路径无效', { field: 'path' })
  }
  return normalized
}

export async function readManageCatalogImage(
  relPath: string,
  signal?: AbortSignal,
  size?: ImageThumbnailSize
): Promise<{ body: Buffer; mime: string }> {
  const normalized = normalizeManageImageRelPath(relPath)
  try {
    return await mediaAssetStore.readForServeAsync(normalized, signal, size)
  } catch (error) {
    if (
      error instanceof AssetReadQueueFullError ||
      error instanceof AssetReadTooLargeError ||
      error instanceof AssetPixelLimitError ||
      isStructuredError(error)
    ) {
      throw error
    }
    throw structuredError('INVALID_INPUT', '图片不存在或不可用', { field: 'path' })
  }
}
