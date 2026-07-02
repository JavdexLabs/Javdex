import type { FacetType, Video } from '@shared/types'
import { deleteActress } from './actressRepo'
import { getDb } from './database'

const FACET_TYPES: FacetType[] = ['maker', 'publisher', 'series', 'director']

const FACET_COLUMN: Record<FacetType, keyof Pick<Video, 'maker' | 'publisher' | 'series' | 'director'>> =
  {
    maker: 'maker',
    publisher: 'publisher',
    series: 'series',
    director: 'director'
  }

export interface LibraryCleanupHints {
  actressIds?: number[]
  facets?: Partial<Record<FacetType, string[]>>
}

export interface LibraryCleanupResult {
  facetsRemoved: number
  stubActressesRemoved: number
}

function trimFacetValues(values: string[] | undefined): string[] {
  if (!values?.length) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

export function facetHintsFromVideo(
  video: Pick<Video, 'maker' | 'publisher' | 'series' | 'director'>
): Partial<Record<FacetType, string[]>> {
  return {
    maker: video.maker?.trim() ? [video.maker.trim()] : [],
    publisher: video.publisher?.trim() ? [video.publisher.trim()] : [],
    series: video.series?.trim() ? [video.series.trim()] : [],
    director: video.director?.trim() ? [video.director.trim()] : []
  }
}

export function collectVideoLibraryCleanupHints(videoId: number): LibraryCleanupHints {
  const db = getDb()
  const video = db.prepare('SELECT maker, publisher, series, director FROM videos WHERE id = ?').get(
    videoId
  ) as Pick<Video, 'maker' | 'publisher' | 'series' | 'director'> | undefined
  if (!video) return {}

  const actressIds = (
    db.prepare('SELECT actress_id FROM video_actress WHERE video_id = ?').all(videoId) as {
      actress_id: number
    }[]
  ).map((row) => row.actress_id)

  return {
    actressIds,
    facets: facetHintsFromVideo(video)
  }
}

function facetValueUnused(type: FacetType, value: string): boolean {
  const col = FACET_COLUMN[type]
  const db = getDb()
  const row = db.prepare(`SELECT COUNT(*) AS c FROM videos WHERE ${col} = ?`).get(value) as {
    c: number
  }
  return row.c === 0
}

/** Remove a facet registry row when no video references that column value. */
export function pruneFacetEntryIfUnused(type: FacetType, value: string | null | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed || !facetValueUnused(type, trimmed)) return false

  const info = getDb()
    .prepare('DELETE FROM facet_entries WHERE type = ? AND value = ?')
    .run(type, trimmed)
  return info.changes > 0
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

/** Remove orphan facet registry rows and stub actresses after library mutations. */
export function runLibraryCleanup(hints: LibraryCleanupHints = {}): LibraryCleanupResult {
  let facetsRemoved = 0
  let stubActressesRemoved = 0

  if (hints.facets) {
    for (const type of FACET_TYPES) {
      for (const value of trimFacetValues(hints.facets[type])) {
        if (pruneFacetEntryIfUnused(type, value)) facetsRemoved += 1
      }
    }
  }

  if (hints.actressIds?.length) {
    const seen = new Set<number>()
    for (const id of hints.actressIds) {
      if (seen.has(id)) continue
      seen.add(id)
      if (pruneStubActressIfOrphan(id)) stubActressesRemoved += 1
    }
  }

  return { facetsRemoved, stubActressesRemoved }
}
