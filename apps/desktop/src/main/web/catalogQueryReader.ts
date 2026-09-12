import { createRevisionReadCache, type ReadCacheMemo } from '../db/revisionReadCache'
import type Database from 'better-sqlite3'
import type { WebBrowse, WebCollection, WebVideo } from '@shared/webTypes'
import type { Video } from '@shared/videoTypes'
import { createHomeDiscoveryRepo } from '../db/homeDiscoveryRepo'

import { normalizeWebBrowseQuery, normalizeWebSeed, webBrowseParams, integer, WebCatalogQueryError, type WebBrowseQuery } from './catalogQueryRequest'
/** Every lookup is constrained to visible memberships of active media libraries. */
const VISIBLE = `EXISTS (SELECT 1 FROM library_video_memberships m
  JOIN media_libraries l ON l.id = m.library_id
  WHERE m.video_id = v.id AND m.is_hidden = 0 AND l.status = 'active')`
const PAGE_SIZE = 36
function card(video: Video): WebVideo {
  return {
    id: video.id,
    code: video.code,
    title: video.title || video.code,
    cover: video.cover_path ? `/api/videos/${video.id}/images/cover` : null,
    releaseDate: video.release_date,
    duration: video.duration_seconds,
    rating: video.rating
  }
}

/** SQL-only reader: no media paths, authorization, or Electron services. */
export class WebCatalogQueryReader {
  private readonly cache
  private readonly homeRepo
  constructor(private readonly db: Database.Database) {
    this.homeRepo = createHomeDiscoveryRepo({database:db})
    this.cache = createRevisionReadCache(db, {
      pages: {maxEntries:8,maxBytes:4*1024*1024},
      counts: {maxEntries:32,maxBytes:256*1024},
      collections: {maxEntries:1,maxBytes:512*1024}
    })
  }
  home(seed: string): { discovery: WebVideo[]; recent: WebVideo[] } {
    normalizeWebSeed(seed)
    const snapshot = this.homeRepo.load({ seed })
    return { discovery: snapshot.discovery.map(card), recent: snapshot.recent.map(card) }
  }
  collections(): { libraries: WebCollection[]; playlists: WebCollection[] } {
    return this.cache.read(memo=>memo.get('collections','all',()=>this.readCollections()))
  }
  private readCollections(): { libraries: WebCollection[]; playlists: WebCollection[] } {
    return {
      libraries: this.db
        .prepare(
          `SELECT l.id, l.name, COUNT(m.video_id) AS count FROM media_libraries l
        LEFT JOIN library_video_memberships m ON m.library_id = l.id AND m.is_hidden = 0
        WHERE l.status = 'active' GROUP BY l.id ORDER BY l.position, l.id`
        )
        .all() as WebCollection[],
      playlists: this.db
        .prepare(
          `SELECT p.id, p.name, COUNT(v.id) AS count FROM playlists p
        JOIN playlist_video pv ON pv.playlist_id = p.id JOIN videos v ON v.id = pv.video_id
        WHERE ${VISIBLE} GROUP BY p.id ORDER BY p.name, p.id`
        )
        .all() as WebCollection[]
    }
  }
  browse(input: WebBrowseQuery): WebBrowse {
    const normalized=normalizeWebBrowseQuery(input)
    return this.cache.read(memo=>memo.get('pages',JSON.stringify(normalized),()=>this.readBrowse(normalized,memo)))
  }
  private readBrowse(input: WebBrowseQuery, memo: ReadCacheMemo): WebBrowse {
    const query = webBrowseParams(normalizeWebBrowseQuery(input))
    const page = integer(query, 'page') ?? 1
    const search = query.get('q')?.trim() ?? ''
    // Search may match most videos. Resolve visibility once rather than allowing
    // a correlated lookup to rescan the visible-membership index for every row.
    const conditions = [search ? `v.id IN (
      SELECT m.video_id FROM library_video_memberships m
      JOIN media_libraries l ON l.id = m.library_id
      WHERE m.is_hidden = 0 AND l.status = 'active'
    )` : VISIBLE]
    const params: (number | string)[] = []
    if (search.length > 200) throw new WebCatalogQueryError('搜索词过长')
    if (search) {
      // Web retains main-name-only matching and literal wildcard handling.
      conditions.push(`(v.code LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\' OR v.id IN (
        WITH matched_actresses AS MATERIALIZED (
          SELECT a.id FROM actresses a WHERE a.main_name LIKE ? ESCAPE '\\'
        )
        SELECT va.video_id FROM matched_actresses matched
        CROSS JOIN video_actress va ON va.actress_id = matched.id
      ))`)
      const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
      params.push(pattern, pattern, pattern)
    }
    const library = integer(query, 'library')
    if (library) {
      conditions.push(`EXISTS (SELECT 1 FROM library_video_memberships m JOIN media_libraries l ON l.id = m.library_id
        WHERE m.video_id = v.id AND m.library_id = ? AND m.is_hidden = 0 AND l.status = 'active')`)
      params.push(library)
    }
    for (const [key, table, column] of [
      ['actress', 'video_actress', 'actress_id'],
      ['tag', 'video_tag', 'tag_id'],
      ['playlist', 'playlist_video', 'playlist_id']
    ] as const) {
      const id = integer(query, key)
      if (id) {
        conditions.push(
          `EXISTS (SELECT 1 FROM ${table} f WHERE f.video_id = v.id AND f.${column} = ?)`
        )
        params.push(id)
      }
    }
    const year = integer(query, 'year')
    if (year) {
      conditions.push('substr(v.release_date, 1, 4) = ?')
      params.push(String(year))
    }
    const sorts: Record<string, string> = {
      recent: 'v.add_time DESC',
      released: 'v.release_date DESC',
      rating: 'v.rating DESC',
      code: 'v.code ASC'
    }
    const sort = query.get('sort') ?? 'recent'
    if (!Object.hasOwn(sorts, sort)) throw new WebCatalogQueryError('排序参数无效')
    const where = conditions.join(' AND ')
    const total = memo.get('counts',JSON.stringify([where,params]),()=> (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM videos v WHERE ${where}`)
        .get(...params) as { count: number }
    ).count)
    const videos = this.db
      .prepare(
        `SELECT v.* FROM videos v WHERE ${where} ORDER BY ${sorts[sort]}, v.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Video[]
    return { items: videos.map(card), total, page, pageSize: PAGE_SIZE }
  }
}
