import path from 'node:path'
import type Database from 'better-sqlite3'
import type {
  WebBrowse,
  WebCollection,
  WebDetail,
  WebVideo
} from '@shared/webTypes'
import type { Video } from '@shared/videoTypes'
import { getVideoDetail } from '../db/videoRepo'
import { createAuthorizedMediaLibraryRootFileInspector } from '../services/mediaLibraryRootFileGuard'
import { mediaAssetStore } from '../services/mediaAssetStore'
import { VIDEO_MIMES, WebError } from './http'

/** Every lookup is constrained to visible memberships of active media libraries. */
const VISIBLE = `EXISTS (SELECT 1 FROM library_video_memberships m
  JOIN media_libraries l ON l.id = m.library_id
  WHERE m.video_id = v.id AND m.is_hidden = 0 AND l.status = 'active')`
const PAGE_SIZE = 36
function integer(query: URLSearchParams, name: string): number | undefined {
  const value = query.get(name)
  if (value === null || value === '') return undefined
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 1 ||
    Number(value) > 1000000000
  )
    throw new WebError(400, '筛选参数无效')
  return Number(value)
}
function card(video: Video): WebVideo {
  return {
    id: video.id,
    code: video.code,
    title: video.title || video.code,
    cover:
      video.poster_path || video.cover_path
        ? `/api/videos/${video.id}/images/cover`
        : null,
    releaseDate: video.release_date,
    duration: video.duration_seconds,
    rating: video.rating
  }
}
function externalTarget(locator: string): string | null {
  try {
    const url = new URL(locator)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null
    return url.href
  } catch {
    return null
  }
}
export class WebCatalog {
  constructor(private readonly db: Database.Database) {}
  collections(): { libraries: WebCollection[]; playlists: WebCollection[] } {
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
  browse(query: URLSearchParams): WebBrowse {
    const page = integer(query, 'page') ?? 1
    const conditions = [VISIBLE]
    const params: (number | string)[] = []
    const search = query.get('q')?.trim() ?? ''
    if (search.length > 200) throw new WebError(400, '搜索词过长')
    if (search) {
      conditions.push(`(v.code LIKE ? ESCAPE '\\' OR v.title LIKE ? ESCAPE '\\' OR EXISTS
        (SELECT 1 FROM video_actress va JOIN actresses a ON a.id = va.actress_id WHERE va.video_id = v.id AND a.main_name LIKE ? ESCAPE '\\'))`)
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
    if (!Object.hasOwn(sorts, sort)) throw new WebError(400, '排序参数无效')
    const where = conditions.join(' AND ')
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM videos v WHERE ${where}`)
        .get(...params) as { count: number }
    ).count
    const videos = this.db
      .prepare(
        `SELECT v.* FROM videos v WHERE ${where} ORDER BY ${sorts[sort]}, v.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Video[]
    return { items: videos.map(card), total, page, pageSize: PAGE_SIZE }
  }
  private visibleDetail(id: number) {
    if (
      !this.db
        .prepare(`SELECT v.id FROM videos v WHERE v.id = ? AND ${VISIBLE}`)
        .get(id)
    )
      throw new WebError(404, '影片不存在或未开放浏览')
    const video = getVideoDetail(id, this.db)
    if (!video) throw new WebError(404, '影片不存在')
    const libraries = new Set(
      (
        this.db
          .prepare(
            `SELECT m.library_id AS id FROM library_video_memberships m
      JOIN media_libraries l ON l.id = m.library_id WHERE m.video_id = ? AND m.is_hidden = 0 AND l.status = 'active'`
          )
          .all(id) as { id: number }[]
      ).map((row) => row.id)
    )
    return {
      ...video,
      resources: video.resources.filter((resource) =>
        libraries.has(resource.library_id)
      )
    }
  }
  detail(id: number): WebDetail {
    const video = this.visibleDetail(id)
    return {
      ...card(video),
      summary: video.summary,
      maker: video.maker,
      publisher: video.publisher,
      series: video.series,
      director: video.director,
      actresses: video.actresses.map((a) => ({ id: a.id, name: a.main_name })),
      tags: video.tags.map((t) => ({ id: t.id, name: t.name })),
      images: video.assets
        .filter((a) => a.type === 'sample' && a.local_path)
        .slice(0, 80)
        .map((a) => `/api/videos/${id}/images/${a.id}`),
      resources: video.resources.map((r, index) => {
        const target = r.kind === 'direct' ? externalTarget(r.locator) : null
        const mime =
          VIDEO_MIMES[
            path
              .extname(
                r.kind === 'local'
                  ? r.locator
                  : target
                    ? new URL(target).pathname
                    : ''
              )
              .toLowerCase()
          ] ?? null
        const playable =
          r.kind === 'local'
            ? r.root_id !== null && mime !== null
            : Boolean(target)
        return {
          id: r.id,
          name: r.display_name || `资源 ${index + 1}`,
          kind: r.kind,
          mime,
          playable,
          reason: playable
            ? null
            : r.kind === 'local' && r.root_id === null
              ? '此文件未关联启用的媒体库目录，请在桌面端管理'
              : '此资源不支持浏览器原生播放'
        }
      })
    }
  }
  image(id: number, key: string): { body: Buffer; mime: string } {
    const video = this.visibleDetail(id)
    const rel =
      key === 'cover'
        ? video.poster_path || video.cover_path
        : video.assets.find((a) => String(a.id) === key && a.type === 'sample')
            ?.local_path
    if (!rel) throw new WebError(404, '图片不存在')
    const image = mediaAssetStore.readForServe(rel)
    if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(image.mime))
      throw new WebError(404, '图片格式不可用')
    return image
  }
  media(id: number, resourceId: number) {
    const resource = this.visibleDetail(id).resources.find(
      (r) => r.id === resourceId
    )
    if (!resource) throw new WebError(404, '资源不存在')
    if (resource.kind === 'direct') {
      const target = externalTarget(resource.locator)
      if (target) return { redirect: target } as const
    }
    if (resource.kind !== 'local' || resource.root_id === null)
      throw new WebError(415, '此资源不支持网页播放')
    const mime = VIDEO_MIMES[path.extname(resource.locator).toLowerCase()]
    if (!mime) throw new WebError(415, '此文件格式不支持原生播放')
    const checked = createAuthorizedMediaLibraryRootFileInspector()(
      resource.library_id,
      resource.root_id,
      resource.locator
    )
    return { file: checked.fileRealPath, stat: checked.stat, mime } as const
  }
}
export type WebCatalogReader = Pick<
  WebCatalog,
  'collections' | 'browse' | 'detail' | 'image' | 'media'
>
