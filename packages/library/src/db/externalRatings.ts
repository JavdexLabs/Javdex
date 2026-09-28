import type Database from 'better-sqlite3'
import type { VideoExternalStats } from '@shared/videoTypes'
import { selectDefaultExternalRating } from '@shared/externalRatings'

/** Call inside the rating mutation's transaction. Never replaces a valid manual choice. */
export function ensureDefaultExternalRating(db: Database.Database, videoId: number): void {
  const ratings = db.prepare('SELECT * FROM video_external_stats WHERE video_id = ?')
    .all(videoId) as VideoExternalStats[]
  const selected = selectDefaultExternalRating(ratings)
  db.prepare('UPDATE video_external_stats SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE video_id = ?')
    .run(selected?.id ?? null, videoId)
}
