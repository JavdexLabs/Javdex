import fs from 'node:fs'
import {
  getOrLoadImageInspection,
  invalidateAssetCache,
  type ImageAssetInspection
} from '../assetCache'
import {
  avatarSourceFingerprint,
  isUsableImageBuffer,
  readImageDimensionsFromBuffer
} from './imageBytes'
import { readAssetForServe, resolveAssetPath } from './filesystem'
import type { ImageDimensions } from './types'

export {
  avatarSourceFingerprint,
  detectImageExtensionFromBuffer,
  isUsableImageBuffer,
  readImageDimensionsFromBuffer,
  readImageDimensionsFromPath
} from './imageBytes'

/** True when a stored relative asset path resolves to a readable non-empty image. */
export function isUsableImageAsset(relPath: string | null | undefined): boolean {
  if (!relPath?.trim()) return false
  try {
    const abs = resolveAssetPath(relPath.trim())
    if (!fs.existsSync(abs)) return false
    const { body } = readAssetForServe(relPath.trim())
    return isUsableImageBuffer(body)
  } catch {
    return false
  }
}

/** Cached usability + content identity for list queries that need both values. */
export function inspectImageAsset(relPath: string | null | undefined): ImageAssetInspection {
  const normalizedPath = relPath?.trim()
  if (!normalizedPath) return { usable: false, fingerprint: null }

  try {
    const abs = resolveAssetPath(normalizedPath)
    const stat = fs.statSync(abs)
    if (!stat.isFile() || stat.size === 0) {
      invalidateAssetCache(normalizedPath)
      return { usable: false, fingerprint: null }
    }

    return getOrLoadImageInspection(
      normalizedPath,
      {
        resolvedPath: abs,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size
      },
      () => {
        const { body } = readAssetForServe(normalizedPath)
        const usable = isUsableImageBuffer(body)
        return {
          usable,
          fingerprint: usable ? avatarSourceFingerprint(body) : null
        }
      }
    )
  } catch {
    invalidateAssetCache(normalizedPath)
    return { usable: false, fingerprint: null }
  }
}

/** Read image dimensions from a stored relative asset path (supports encrypted assets). */
export function readImageDimensionsFromRelPath(
  relPath: string | null | undefined
): ImageDimensions | null {
  if (!relPath?.trim()) return null
  try {
    const { body } = readAssetForServe(relPath.trim())
    return readImageDimensionsFromBuffer(body)
  } catch {
    return null
  }
}
