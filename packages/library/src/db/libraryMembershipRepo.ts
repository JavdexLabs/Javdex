import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
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

/** One cooperative cleanup page. The caller owns the business/audit transaction.
 * IDs come from its fixed candidate scope; current protection is always rechecked.
 */
export function removeResourceLessMembershipPage(
  libraryId: number, ids: readonly number[], onRemoved: (entry: RemovedResourceLessMembership) => void,
  database: Database.Database = getDb()
): number {
  positiveId(libraryId, '媒体库 ID')
  if (!database.inTransaction || ids.length > 128 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Invalid membership cleanup page')
  }
  const read = database.prepare(`SELECT v.code,v.title FROM library_video_memberships m JOIN videos v ON v.id=m.video_id
    WHERE m.library_id=? AND m.video_id=? AND m.is_pinned=0
      AND NOT EXISTS (SELECT 1 FROM playlist_video p WHERE p.video_id=m.video_id)
      AND NOT EXISTS (SELECT 1 FROM video_resources r WHERE r.library_id=m.library_id AND r.video_id=m.video_id)`)
  const remove = database.prepare('DELETE FROM library_video_memberships WHERE library_id=? AND video_id=?')
  let count = 0
  for (const id of ids) {
    const video = read.get(libraryId, id) as { code: string; title: string | null } | undefined
    if (!video || remove.run(libraryId, id).changes !== 1) continue
    const returned: unknown = onRemoved({ videoId: id, videoCode: video.code, videoTitle: video.title })
    if (returned != null && typeof (returned as { then?: unknown }).then === 'function') {
      void Promise.resolve(returned).catch(() => {})
      throw new Error('Membership cleanup audit callback must be synchronous')
    }
    count++
  }
  return count
}

/**
 * Remove only unpinned memberships that have no resource in this library. Catalog videos and
 * memberships in every other library remain untouched.
 */
export function removeResourceLessMemberships(
  libraryId: number,
  database: Database.Database = getDb()
): RemovedResourceLessMembership[] {
  const removed: RemovedResourceLessMembership[] = []
  removeResourceLessMembershipsWithAudit(libraryId, (entry) => { removed.push(entry) }, database)
  return removed
}

/**
 * Snapshot initial eligible IDs/code/title in SQL; deliver only actual deletions.
 * Each <=256-row keyset page finishes reading before any write/callback. Metadata
 * remains untruncated, so the row bound is not a byte bound for unusually long names.
 * Synchronous callbacks run before commit and may use nested writer savepoints.
 * Failure rolls back both cleanup and callback writes, including the TEMP table.
 */
export function removeResourceLessMembershipsWithAudit(
  libraryId: number,
  onRemoved: (entry: RemovedResourceLessMembership) => void,
  database: Database.Database = getDb()
): number {
  const scopedLibraryId = positiveId(libraryId, '媒体库 ID')
  return database.transaction(() => {
    const table = `membership_cleanup_${randomUUID().replaceAll('-', '')}`
    database.exec(`CREATE TEMP TABLE ${table} (
      video_id INTEGER PRIMARY KEY, video_code TEXT NOT NULL, video_title TEXT
    )`)
    database.prepare(`INSERT INTO temp.${table}(video_id,video_code,video_title)
      SELECT video.id, video.code, video.title
      FROM library_video_memberships membership JOIN videos video ON video.id=membership.video_id
      WHERE membership.library_id=? AND membership.is_pinned=0
        AND NOT EXISTS (SELECT 1 FROM playlist_video playlist_item WHERE playlist_item.video_id=membership.video_id)
        AND NOT EXISTS (SELECT 1 FROM video_resources resource
          WHERE resource.library_id=membership.library_id AND resource.video_id=membership.video_id)`)
      .run(scopedLibraryId)
    const read = database.prepare(`SELECT video_id,video_code,video_title FROM temp.${table}
      WHERE video_id>? ORDER BY video_id LIMIT 256`)
    const remove = database.prepare(
      `DELETE FROM library_video_memberships
        WHERE library_id = ? AND video_id = ? AND is_pinned = 0
          AND NOT EXISTS (
            SELECT 1 FROM playlist_video playlist_item
             WHERE playlist_item.video_id = library_video_memberships.video_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM video_resources resource
             WHERE resource.library_id = library_video_memberships.library_id
               AND resource.video_id = library_video_memberships.video_id
          )`
    )
    let count = 0, afterId = 0
    for (;;) {
      const page = read.all(afterId) as { video_id: number; video_code: string; video_title: string | null }[]
      if (page.length === 0) break
      afterId = page[page.length - 1].video_id
      for (const candidate of page) {
        // Preserve the legacy recheck/skip behavior if a prior callback protects
        // another candidate or a DELETE trigger ignores its removal.
        if (remove.run(scopedLibraryId, candidate.video_id).changes !== 1) continue
        const returned: unknown = onRemoved({
          videoId: candidate.video_id, videoCode: candidate.video_code, videoTitle: candidate.video_title
        })
        if (returned != null && (typeof returned === 'object' || typeof returned === 'function') &&
            typeof (returned as { then?: unknown }).then === 'function') {
          void Promise.resolve(returned).catch(() => {})
          throw new Error('Membership cleanup audit callback must be synchronous')
        }
        count++
      }
    }
    database.exec(`DROP TABLE temp.${table}`)
    return count
  })()
}
