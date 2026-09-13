import type Database from 'better-sqlite3'
import type { PlaylistListQuery, PlaylistListPage } from '@shared/playlistTypes'
import { getDb } from './database'

const registered = new WeakSet<Database.Database>()
export function normalizePlaylistListQuery(query: PlaylistListQuery = {}) {
  const { search = '', limit = 60, offset = 0, videoId, locale } = query
  if (typeof search !== 'string' || search.length > 500 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0 || (videoId !== undefined && (!Number.isSafeInteger(videoId) || videoId <= 0))) throw new Error('清单分页参数无效')
  if (locale !== undefined && (typeof locale !== 'string' || !locale || locale.length > 100)) throw new Error('搜索语言无效')
  if (locale !== undefined) Intl.getCanonicalLocales(locale)
  return { search: search.trim(), limit, offset, videoId, locale }
}
function display(value: Buffer | null, limit: number): string | null {
  if (value === null) return null
  const points = Array.from(value.toString('utf8'))
  return points.slice(0, limit).join('') + (points.length > limit ? '…' : '')
}

/** Global playlists retain all references, including hidden/archived/resource-less videos. */
export function listPlaylistBrowsePage(query: PlaylistListQuery = {}, database: Database.Database = getDb()): PlaylistListPage {
  const input = normalizePlaylistListQuery(query)
  if (!registered.has(database)) {
    database.function('playlist_text_matches', { deterministic: true }, (text: unknown, folded: unknown, locale: unknown, exact: unknown) => {
      if (typeof text !== 'string' || typeof folded !== 'string') return 0
      const value = exact ? text.trim() : text
      const normalized = typeof locale === 'string' && locale ? value.toLocaleLowerCase(locale) : value.toLowerCase()
      return (exact ? normalized === folded : normalized.includes(folded)) ? 1 : 0
    })
    registered.add(database)
  }
  const folded = input.locale ? input.search.toLocaleLowerCase(input.locale) : input.search.toLowerCase()
  const filter = input.search ? 'WHERE playlist_text_matches(p.name, ?, ?, 0) OR playlist_text_matches(p.description, ?, ?, 0)' : ''
  const params = input.search ? [folded, input.locale ?? '', folded, input.locale ?? ''] : []
  return database.transaction(() => {
    const total = (database.prepare(`SELECT COUNT(*) AS n FROM playlists p ${filter}`).get(...params) as { n: number }).n
    const offset = Math.min(input.offset, Math.max(0, Math.ceil(total / input.limit) - 1) * input.limit)
    const hasExactName = Boolean(input.search && database.prepare('SELECT 1 FROM playlists WHERE playlist_text_matches(name, ?, ?, 1) LIMIT 1').get(folded, input.locale ?? ''))
    const rows = database.prepare(`WITH page AS MATERIALIZED (
      SELECT p.id, p.created_at FROM playlists p ${filter} ORDER BY p.created_at DESC, p.id DESC LIMIT ? OFFSET ?
    ), projected AS MATERIALIZED (
      SELECT p.id, page.created_at,
        substr(CAST(p.name AS BLOB),1,516) AS name_prefix,
        substr(CAST(p.description AS BLOB),1,1028) AS description_prefix,
        (SELECT COUNT(*) FROM playlist_video pv WHERE pv.playlist_id=p.id) AS video_count,
        EXISTS(SELECT 1 FROM playlist_video pv WHERE pv.playlist_id=p.id AND pv.video_id=?) AS contains_video,
        COALESCE(p.cover_path,(SELECT v.cover_path FROM playlist_video pv2 JOIN videos v ON v.id=pv2.video_id
          WHERE pv2.playlist_id=p.id AND v.cover_path IS NOT NULL AND trim(v.cover_path)!=''
          ORDER BY pv2.position,pv2.added_at,pv2.video_id LIMIT 1)) AS cover
      FROM page JOIN playlists p ON p.id=page.id
    ) SELECT id,name_prefix,description_prefix,video_count,contains_video,
      CASE WHEN length(CAST(cover AS BLOB))<=4096 THEN cover ELSE NULL END AS preview_cover_path
      FROM projected ORDER BY created_at DESC,id DESC`).all(...params, input.limit, offset, input.videoId ?? null) as Array<{
        id: number; name_prefix: Buffer; description_prefix: Buffer | null; video_count: number; contains_video: number; preview_cover_path: string | null
      }>
    return { total, offset, limit: input.limit, hasExactName, items: rows.map(row => ({
      id: row.id, name: display(row.name_prefix,128)!, description: display(row.description_prefix,256),
      video_count: row.video_count, contains_video: Boolean(row.contains_video), preview_cover_path: row.preview_cover_path
    })) }
  })()
}
