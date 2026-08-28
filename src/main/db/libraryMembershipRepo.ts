import type Database from 'better-sqlite3'
import { getDb } from './database'

export type MembershipAddedVia = 'scan' | 'manual' | 'shared'

function positiveId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 必须是正整数`)
  return value
}

export function discoveryKeyForMembership(libraryId: number, videoId: number): number {
  const left = positiveId(libraryId, '媒体库 ID')
  const right = positiveId(videoId, '影片 ID')
  return ((Math.imul(left, 1_103_515_245) ^ Math.imul(right, 1_664_525) ^ 12_345) >>> 1)
}

export function ensureVideoMembership(
  input: {
    libraryId: number
    videoId: number
    addedVia: MembershipAddedVia
    addedAt?: string
  },
  database: Database.Database = getDb()
): boolean {
  const libraryId = positiveId(input.libraryId, '媒体库 ID')
  const videoId = positiveId(input.videoId, '影片 ID')
  const timestamp = input.addedAt ?? new Date().toISOString()
  const info = database
    .prepare(
      `INSERT OR IGNORE INTO library_video_memberships (
         library_id, video_id, added_at, updated_at, added_via,
         is_pinned, is_hidden, discovery_key
       )
       SELECT ?, ?, ?, ?, ?, 0, 0, ?
       WHERE EXISTS (
         SELECT 1 FROM media_libraries WHERE id = ? AND status = 'active'
       ) AND EXISTS (
         SELECT 1 FROM videos WHERE id = ?
       )`
    )
    .run(
      libraryId,
      videoId,
      timestamp,
      timestamp,
      input.addedVia,
      discoveryKeyForMembership(libraryId, videoId),
      libraryId,
      videoId
    )
  if (info.changes === 1) return true

  const exists = database
    .prepare(
      `SELECT 1 FROM library_video_memberships
       WHERE library_id = ? AND video_id = ?`
    )
    .get(libraryId, videoId)
  if (exists) return false
  throw new Error('媒体库或影片不存在，无法建立成员关系')
}

export function hasVideoMembership(
  libraryId: number,
  videoId: number,
  database: Database.Database = getDb()
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM library_video_memberships
         WHERE library_id = ? AND video_id = ?`
      )
      .get(positiveId(libraryId, '媒体库 ID'), positiveId(videoId, '影片 ID'))
  )
}

/** True only when the video is visible through the requested active media-library surface. */
export function hasActiveVisibleVideoMembership(
  libraryId: number,
  videoId: number,
  database: Database.Database = getDb()
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1
           FROM library_video_memberships membership
           JOIN media_libraries library ON library.id = membership.library_id
          WHERE membership.library_id = ?
            AND membership.video_id = ?
            AND membership.is_hidden = 0
            AND library.status = 'active'`
      )
      .get(positiveId(libraryId, '媒体库 ID'), positiveId(videoId, '影片 ID'))
  )
}

export function hasVideoMembershipOutsideLibrary(
  libraryId: number,
  videoId: number,
  database: Database.Database = getDb()
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM library_video_memberships
         WHERE video_id = ? AND library_id != ?
         LIMIT 1`
      )
      .get(positiveId(videoId, '影片 ID'), positiveId(libraryId, '媒体库 ID'))
  )
}

export function removeVideoMembership(
  libraryId: number,
  videoId: number,
  database: Database.Database = getDb()
): boolean {
  return (
    database
      .prepare('DELETE FROM library_video_memberships WHERE library_id = ? AND video_id = ?')
      .run(positiveId(libraryId, '媒体库 ID'), positiveId(videoId, '影片 ID')).changes === 1
  )
}

export interface RemovedResourceLessMembership {
  videoId: number
  videoCode: string
  videoTitle: string | null
}

/**
 * Remove only unpinned memberships that have no resource in this library. Catalog videos and
 * memberships in every other library remain untouched.
 */
export function removeResourceLessMemberships(
  libraryId: number,
  database: Database.Database = getDb()
): RemovedResourceLessMembership[] {
  const scopedLibraryId = positiveId(libraryId, '媒体库 ID')
  return database.transaction(() => {
    const candidates = database
      .prepare(
        `SELECT video.id AS video_id, video.code AS video_code, video.title AS video_title
           FROM library_video_memberships membership
           JOIN videos video ON video.id = membership.video_id
          WHERE membership.library_id = ?
            AND membership.is_pinned = 0
            AND NOT EXISTS (
              SELECT 1 FROM video_resources resource
               WHERE resource.library_id = membership.library_id
                 AND resource.video_id = membership.video_id
            )
          ORDER BY video.id`
      )
      .all(scopedLibraryId) as Array<{
      video_id: number
      video_code: string
      video_title: string | null
    }>
    const remove = database.prepare(
      `DELETE FROM library_video_memberships
        WHERE library_id = ? AND video_id = ? AND is_pinned = 0
          AND NOT EXISTS (
            SELECT 1 FROM video_resources resource
             WHERE resource.library_id = library_video_memberships.library_id
               AND resource.video_id = library_video_memberships.video_id
          )`
    )
    const removed: RemovedResourceLessMembership[] = []
    for (const candidate of candidates) {
      if (remove.run(scopedLibraryId, candidate.video_id).changes !== 1) continue
      removed.push({
        videoId: candidate.video_id,
        videoCode: candidate.video_code,
        videoTitle: candidate.video_title
      })
    }
    return removed
  })()
}
