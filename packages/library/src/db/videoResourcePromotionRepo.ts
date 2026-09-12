import type Database from 'better-sqlite3'
import { selectPrimaryVideoResourceCandidate } from '@shared/videoResourcePromotion'
import type { VideoResource } from '@shared/videoTypes'

/**
 * Reads and selects a promotion candidate inside one library/video ownership scope.
 * Callers supply availability so tests and non-default filesystems do not depend on global state.
 */
export function selectLibraryVideoResourcePromotionCandidate(
  database: Database.Database,
  input: {
    libraryId: number
    videoId: number
    isLocalAccessible: (path: string) => boolean
  }
): VideoResource | null {
  const resources = database
    .prepare(
      `SELECT * FROM video_resources
        WHERE library_id = ? AND video_id = ?
        ORDER BY id`
    )
    .all(input.libraryId, input.videoId) as VideoResource[]
  return selectPrimaryVideoResourceCandidate(resources, input.isLocalAccessible)
}
