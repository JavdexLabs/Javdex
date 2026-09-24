import { deleteActress } from './actressRepo'
import { getDb } from './database'
import { pruneUnusedTags } from './tagRepo'

export interface LibraryCleanupHints {
  actressIds?: number[]
}

export interface LibraryCleanupResult {
  stubActressesRemoved: number
  unusedTagsRemoved: number
}

export function collectVideoLibraryCleanupHints(videoId: number): LibraryCleanupHints {
  const db = getDb()
  if (!db.prepare('SELECT 1 FROM videos WHERE id = ?').get(videoId)) return {}

  const actressIds = (
    db.prepare('SELECT actress_id FROM video_actress WHERE video_id = ?').all(videoId) as {
      actress_id: number
    }[]
  ).map((row) => row.actress_id)

  return { actressIds }
}

/** Actress with no videos and no meaningful profile beyond the main name. */
export function isStubActress(id: number): boolean {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT a.id
       FROM actresses a
       WHERE a.id = ?
         AND NOT EXISTS (SELECT 1 FROM video_actress va WHERE va.actress_id = a.id)
         AND (a.avatar_path IS NULL OR trim(a.avatar_path) = '')
         AND (a.avatar_source_path IS NULL OR trim(a.avatar_source_path) = '')
         AND (a.poster_path IS NULL OR trim(a.poster_path) = '')
         AND NOT EXISTS (SELECT 1 FROM actress_gallery_assets ag WHERE ag.actress_id = a.id)
         AND a.birth_date IS NULL
         AND a.debut_date IS NULL
         AND a.height_cm IS NULL
         AND a.bust_cm IS NULL
         AND a.waist_cm IS NULL
         AND a.hip_cm IS NULL
         AND (a.cup_size IS NULL OR trim(a.cup_size) = '')
         AND (a.blood_type IS NULL OR trim(a.blood_type) = '')
         AND (a.zodiac IS NULL OR trim(a.zodiac) = '')
         AND (a.nationality IS NULL OR trim(a.nationality) = '')
         AND (a.profile_summary IS NULL OR trim(a.profile_summary) = '')
         AND NOT EXISTS (
           SELECT 1 FROM actress_names an
           WHERE an.actress_id = a.id AND an.type != 'main'
         )`
    )
    .get(id) as { id: number } | undefined
  return row != null
}

export function pruneStubActressIfOrphan(id: number): boolean {
  if (!isStubActress(id)) return false
  deleteActress(id)
  return true
}

/** Remove stub actresses after library mutations. Classification entities are explicit records. */
export function runLibraryCleanup(hints: LibraryCleanupHints = {}): LibraryCleanupResult {
  let stubActressesRemoved = 0

  if (hints.actressIds?.length) {
    const seen = new Set<number>()
    for (const id of hints.actressIds) {
      if (seen.has(id)) continue
      seen.add(id)
      if (pruneStubActressIfOrphan(id)) stubActressesRemoved += 1
    }
  }

  return { stubActressesRemoved, unusedTagsRemoved: pruneUnusedTags() }
}
