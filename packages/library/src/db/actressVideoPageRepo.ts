import type { ActressVideoPage, ActressVideoPageQuery } from '@shared/actressTypes'
import { getDb } from './database'
import { hydrateVideoCardRows, videoCardSelect, type VideoCardProjectionRow } from './videoListProjection'

const VISIBLE_WORK = `EXISTS (
  SELECT 1 FROM library_video_memberships membership
  JOIN media_libraries library ON library.id = membership.library_id
  WHERE membership.video_id = v.id AND membership.is_hidden = 0 AND library.status = 'active'
)`

/** A read transaction keeps the exact count and page on the same SQLite snapshot. */
export function listActressVideoPage(id: number, query: ActressVideoPageQuery = {}): ActressVideoPage | null {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid actress ID')
  const limit = query.limit ?? 60
  const offset = query.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 240) throw new Error('Invalid actress video page limit')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid actress video page offset')
  if (query.withCover !== undefined && typeof query.withCover !== 'boolean') throw new Error('Invalid cover filter')
  const coverFilter = query.withCover ? ' AND length(CAST(v.cover_path AS BLOB)) > 0' : ''
  const db = getDb()
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM actresses WHERE id = ?').get(id)) return null
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM video_actress va
      JOIN videos v ON v.id = va.video_id WHERE va.actress_id = ? AND ${VISIBLE_WORK}${coverFilter}`)
      .get(id) as { n: number }).n
    // Complete the ordered ID page before projecting resource badges. ID breaks equal-date ties.
    const rows = db.prepare(`WITH page AS MATERIALIZED (
      SELECT v.id, v.release_date, v.add_time FROM video_actress va
      JOIN videos v ON v.id = va.video_id WHERE va.actress_id = ? AND ${VISIBLE_WORK}${coverFilter}
      ORDER BY v.release_date DESC, v.add_time DESC, v.id ASC LIMIT ? OFFSET ?
    ) SELECT ${videoCardSelect()} FROM page p JOIN videos v ON v.id = p.id
      ORDER BY p.release_date DESC, p.add_time DESC, p.id ASC`)
      .all(id, limit, offset) as VideoCardProjectionRow[]
    return { videos: hydrateVideoCardRows(rows), total, limit, offset }
  })()
}
