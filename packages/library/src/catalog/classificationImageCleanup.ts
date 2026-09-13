import type { ClassificationImageCleanupFailure } from '@shared/classificationTypes'

export function obsoleteSourceImagePath(
  targetImagePath: string | null,
  sourceImagePath: string | null
): string | null {
  return targetImagePath && sourceImagePath && targetImagePath !== sourceImagePath
    ? sourceImagePath
    : null
}

export function cleanupClassificationImage(
  obsoleteImagePath: string | null,
  deleteStoredImage: (storedPath: string) => void
): ClassificationImageCleanupFailure[] {
  if (!obsoleteImagePath) return []
  try {
    deleteStoredImage(obsoleteImagePath)
    return []
  } catch (error) {
    return [
      {
        path: obsoleteImagePath,
        error: error instanceof Error ? error.message : String(error)
      }
    ]
  }
}
