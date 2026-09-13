import fs from 'node:fs'
import { getDb } from '@library/db/database'
import { selectLibraryVideoResourcePromotionCandidate } from '@library/db/videoResourcePromotionRepo'

/** Existence-aware primary fallback for pending scan resolve on the live mount. */
export function selectAccessibleFallbackPrimaryResourceId(
  libraryId: number,
  videoId: number
): number | null {
  return (
    selectLibraryVideoResourcePromotionCandidate(getDb(), {
      libraryId,
      videoId,
      isLocalAccessible: (filePath) => fs.existsSync(filePath)
    })?.id ?? null
  )
}
