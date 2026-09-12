import type { ActressGalleryAsset, ActressGalleryPage, ActressGalleryPageQuery } from '@shared/actressTypes'
import { getDb } from './database'

// ECMAScript String.trim whitespace, matching hasActressGalleryDisplaySource exactly.
const TRIM_CHARACTERS = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)'
const DISPLAY_SOURCE = `(length(CAST(trim(local_path, ${TRIM_CHARACTERS}) AS BLOB)) > 0
  OR length(CAST(trim(remote_url, ${TRIM_CHARACTERS}) AS BLOB)) > 0)`
const DISPLAY_ORDER = `CASE WHEN width > 0 AND height > 0
  AND (1.0 * width / height) > 1 AND (1.0 * width / height) < 1e999
  THEN 0 ELSE 1 END, COALESCE(position, 0), id`

/** Global display order precedes LIMIT; no filesystem access or full-gallery JS sort. */
export function listActressGalleryPage(id: number, query: ActressGalleryPageQuery = {}): ActressGalleryPage | null {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid actress ID')
  const limit = query.limit ?? 60
  let offset = query.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid actress gallery page limit')
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid actress gallery page offset')
  if (query.localOnly !== undefined && typeof query.localOnly !== 'boolean') throw new Error('Invalid local source filter')
  if (query.anchorId !== undefined && (!Number.isSafeInteger(query.anchorId) || query.anchorId <= 0)) throw new Error('Invalid gallery anchor ID')
  const localFilter = query.localOnly ? ' AND length(CAST(local_path AS BLOB)) > 0' : ''
  const db = getDb()
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM actresses WHERE id = ?').get(id)) return null
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM actress_gallery_assets
      WHERE actress_id = ? AND ${DISPLAY_SOURCE}${localFilter}`).get(id) as { n: number }).n
    let anchorIndex: number | null = null
    if (query.anchorId !== undefined) {
      const anchor = db.prepare(`SELECT ordinal FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ${DISPLAY_ORDER}) - 1 AS ordinal
        FROM actress_gallery_assets WHERE actress_id = ? AND ${DISPLAY_SOURCE}${localFilter}
      ) WHERE id = ?`).get(id, query.anchorId) as { ordinal: number } | undefined
      if (anchor) {
        offset = Math.floor(anchor.ordinal / limit) * limit
        anchorIndex = anchor.ordinal - offset
      }
    }
    const items = db.prepare(`SELECT * FROM actress_gallery_assets
      WHERE actress_id = ? AND ${DISPLAY_SOURCE}${localFilter} ORDER BY ${DISPLAY_ORDER} LIMIT ? OFFSET ?`)
      .all(id, limit, offset) as ActressGalleryAsset[]
    return { items, total, limit, offset, ...(query.anchorId === undefined ? {} : { anchorIndex }) }
  })()
}
