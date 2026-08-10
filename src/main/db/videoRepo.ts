import { getDb } from './database'
import type {
  Video,
  VideoFile,
  VideoResource,
  VideoResourceImportResult,
  ExternalVideoResourceKind,
  VideoAsset,
  VideoDetail,
  VideoQuery,
  VideoListResult,
  VideoEditInput
} from '@shared/videoTypes'
import type { VideoBatchScrapeFilter, VideoBatchScrapeStatus, VideoRematchScope } from '@shared/videoScrapeTypes'
import { upsertActressFromScrape } from './actressRepo'
import { actressOwnedNamePatternSearchSql } from './actressSearchSql'
import { ensureTag, pruneTagIfUnused } from './tagRepo'
import { ensureFacetEntries } from './facetRepo'
import { collectVideoLibraryCleanupHints, runLibraryCleanup } from './libraryCleanup'
import {
  hydrateVideoListRows,
  videoListSelectExtras,
  type VideoListProjectionRow
} from './videoListProjection'

export interface NewVideo {
  code: string
  file_path: string
  file_size: number | null
  file_duration_seconds?: number | null
  file_mtime_ms?: number | null
}

const PRIMARY_FILE_ORDER = 'ORDER BY is_primary DESC, id ASC'
const LOCAL_FILE_SELECT = `
  id,
  video_id,
  locator AS file_path,
  size_bytes AS file_size,
  duration_seconds AS file_duration_seconds,
  file_mtime_ms,
  display_name AS label,
  is_primary,
  add_time`

export function insertVideoFile(input: {
  video_id: number
  file_path: string
  file_size: number | null
  file_duration_seconds?: number | null
  file_mtime_ms?: number | null
  label?: string | null
  is_primary?: boolean
  add_time?: string
}): number | null {
  const db = getDb()
  const isPrimary = input.is_primary ? 1 : 0
  if (isPrimary) {
    db.prepare('UPDATE video_resources SET is_primary = 0 WHERE video_id = ?').run(input.video_id)
  }
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO video_resources
         (video_id, kind, locator, resource_key, size_bytes, duration_seconds,
          file_mtime_ms, display_name, is_primary, add_time)
       VALUES (@video_id, 'local', @file_path, 'local:' || @file_path, @file_size,
               @file_duration_seconds, @file_mtime_ms, @label, @is_primary, @add_time)`
    )
    .run({
      video_id: input.video_id,
      file_path: input.file_path,
      file_size: input.file_size,
      file_duration_seconds: input.file_duration_seconds ?? null,
      file_mtime_ms: input.file_mtime_ms ?? null,
      label: input.label ?? null,
      is_primary: isPrimary,
      add_time: input.add_time ?? nowIso()
    })
  return info.changes > 0 ? Number(info.lastInsertRowid) : null
}

/**
 * Insert an initial (un-scraped) video record from a scan.
 * Returns the video id, or null if the path already exists.
 */
export function insertScannedVideo(v: NewVideo): number | null {
  const db = getDb()
  if (videoExistsByPath(v.file_path)) return null

  const existing = getVideoByCode(v.code)
  if (existing) {
    const fileId = insertVideoFile({
      video_id: existing.id,
      file_path: v.file_path,
      file_size: v.file_size,
      file_duration_seconds: v.file_duration_seconds ?? null,
      file_mtime_ms: v.file_mtime_ms ?? null,
      is_primary: false
    })
    return fileId != null ? existing.id : null
  }

  return db.transaction(() => {
    const info = db.prepare('INSERT INTO videos (code, scraped_status) VALUES (?, 0)').run(v.code)
    const videoId = Number(info.lastInsertRowid)
    const fileId = insertVideoFile({
      video_id: videoId,
      file_path: v.file_path,
      file_size: v.file_size,
      file_duration_seconds: v.file_duration_seconds ?? null,
      file_mtime_ms: v.file_mtime_ms ?? null,
      is_primary: true
    })
    return fileId != null ? videoId : null
  })()
}

export function videoExistsByPath(filePath: string): boolean {
  const db = getDb()
  const row = db
    .prepare("SELECT 1 FROM video_resources WHERE kind = 'local' AND locator = ?")
    .get(filePath)
  return !!row
}

export function videoExistsByCode(code: string): boolean {
  const db = getDb()
  const row = db.prepare('SELECT 1 FROM videos WHERE code = ?').get(code)
  return !!row
}

export function getVideoByCode(code: string): Pick<Video, 'id' | 'code'> | null {
  const db = getDb()
  return (
    (db.prepare('SELECT id, code FROM videos WHERE code = ?').get(code) as
      | Pick<Video, 'id' | 'code'>
      | undefined) ?? null
  )
}

export function getVideoFileById(fileId: number): VideoFile | null {
  const db = getDb()
  return (
    (db
      .prepare(`SELECT ${LOCAL_FILE_SELECT} FROM video_resources WHERE id = ? AND kind = 'local'`)
      .get(fileId) as VideoFile | undefined) ?? null
  )
}

export function updateVideoFileAfterProbe(
  fileId: number,
  input: {
    file_duration_seconds: number | null
    file_size: number | null
    file_mtime_ms: number | null
  }
): void {
  const db = getDb()
  db.prepare(
    `UPDATE video_resources
     SET duration_seconds = ?, size_bytes = ?, file_mtime_ms = ?
     WHERE id = ? AND kind = 'local'`
  ).run(input.file_duration_seconds, input.file_size, input.file_mtime_ms, fileId)
}

export function backfillVideoFileFingerprint(
  fileId: number,
  input: { file_size: number | null; file_mtime_ms: number | null }
): void {
  const db = getDb()
  db.prepare(
    "UPDATE video_resources SET size_bytes = ?, file_mtime_ms = ? WHERE id = ? AND kind = 'local'"
  ).run(
    input.file_size,
    input.file_mtime_ms,
    fileId
  )
}

export function getVideoFileByPath(filePath: string): VideoFile | null {
  const db = getDb()
  return (
    (db
      .prepare(
        `SELECT ${LOCAL_FILE_SELECT}
         FROM video_resources
         WHERE kind = 'local' AND locator = ?`
      )
      .get(filePath) as VideoFile | undefined) ?? null
  )
}

export function getPrimaryVideoFile(videoId: number): VideoFile | null {
  const db = getDb()
  return (
    (db
      .prepare(
        `SELECT ${LOCAL_FILE_SELECT}
         FROM video_resources
         WHERE video_id = ? AND kind = 'local'
         ${PRIMARY_FILE_ORDER} LIMIT 1`
      )
      .get(videoId) as VideoFile | undefined) ?? null
  )
}

export function listVideoFiles(videoId: number): VideoFile[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT ${LOCAL_FILE_SELECT}
       FROM video_resources
       WHERE video_id = ? AND kind = 'local'
       ${PRIMARY_FILE_ORDER}, id ASC`
    )
    .all(videoId) as VideoFile[]
}

export function countVideoFiles(videoId: number): number {
  const db = getDb()
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM video_resources WHERE video_id = ? AND kind = 'local'")
      .get(videoId) as { n: number }
  ).n
}

export function setPrimaryVideoFile(videoId: number, fileId: number): void {
  const db = getDb()
  const file = getVideoFileById(fileId)
  if (!file || file.video_id !== videoId) {
    throw new Error('File not found for this video')
  }
  db.transaction(() => {
    db.prepare('UPDATE video_resources SET is_primary = 0 WHERE video_id = ?').run(videoId)
    db.prepare("UPDATE video_resources SET is_primary = 1 WHERE id = ? AND kind = 'local'").run(
      fileId
    )
  })()
}

/** Update primary file path/size after a move/rename; keeps scraped metadata and relations. */
export function relocateVideo(
  id: number,
  filePath: string,
  fileSize: number | null,
  fileDurationSeconds: number | null = null,
  fileMtimeMs: number | null = null
): void {
  const db = getDb()
  const primary = getPrimaryVideoFile(id)
  if (primary) {
    db.prepare(
      `UPDATE video_resources
       SET locator = ?, resource_key = 'local:' || ?, size_bytes = ?, duration_seconds = ?,
           file_mtime_ms = ?
       WHERE id = ? AND kind = 'local'`
    ).run(filePath, filePath, fileSize, fileDurationSeconds, fileMtimeMs, primary.id)
    return
  }
  insertVideoFile({
    video_id: id,
    file_path: filePath,
    file_size: fileSize,
    file_duration_seconds: fileDurationSeconds,
    file_mtime_ms: fileMtimeMs,
    is_primary: true
  })
}

/** Remove a video record and its cover asset (files on disk are already gone). */
export function purgeVideo(id: number): { obsoletePaths: string[] } {
  const hints = collectVideoLibraryCleanupHints(id)
  const video = getVideoById(id)
  if (!video) return { obsoletePaths: [] }
  const db = getDb()
  let obsoletePaths: string[] = []
  db.transaction(() => {
    obsoletePaths = deleteVideoAssetRows(id)
    if (video.cover_path) obsoletePaths.push(video.cover_path)
    deleteVideo(id)
  })()
  try {
    runLibraryCleanup(hints)
  } catch (error) {
    console.error('Post-commit library cleanup failed:', error)
  }
  return { obsoletePaths: Array.from(new Set(obsoletePaths)) }
}

/** Remove one file row; purge the video work when no files remain. */
export function purgeVideoFile(fileId: number): { obsoletePaths: string[] } {
  const file = getVideoFileById(fileId)
  if (!file) return { obsoletePaths: [] }
  const videoId = file.video_id
  const db = getDb()
  db.prepare("DELETE FROM video_resources WHERE id = ? AND kind = 'local'").run(fileId)
  if (countVideoFiles(videoId) === 0) {
    return purgeVideo(videoId)
  }
  return { obsoletePaths: [] }
}

export function listVideoFileRefs(): { video_id: number; file_id: number; file_path: string }[] {
  const db = getDb()
  return db
    .prepare(
      "SELECT id AS file_id, video_id, locator AS file_path FROM video_resources WHERE kind = 'local'"
    )
    .all() as { video_id: number; file_id: number; file_path: string }[]
}

/** Delete a file row without purging the parent video. */
export function removeVideoFileRecord(fileId: number): void {
  const db = getDb()
  db.prepare("DELETE FROM video_resources WHERE id = ? AND kind = 'local'").run(fileId)
}

export function getVideoResourceById(resourceId: number): VideoResource | null {
  const db = getDb()
  return (
    (db.prepare('SELECT * FROM video_resources WHERE id = ?').get(resourceId) as
      | VideoResource
      | undefined) ?? null
  )
}

export function listVideoResources(videoId: number): VideoResource[] {
  const db = getDb()
  return db
    .prepare(`SELECT * FROM video_resources WHERE video_id = ? ${PRIMARY_FILE_ORDER}`)
    .all(videoId) as VideoResource[]
}

export function getPrimaryVideoResource(videoId: number): VideoResource | null {
  const db = getDb()
  return (
    (db
      .prepare(
        'SELECT * FROM video_resources WHERE video_id = ? AND is_primary = 1 ORDER BY id ASC LIMIT 1'
      )
      .get(videoId) as VideoResource | undefined) ?? null
  )
}

export function setPrimaryVideoResource(videoId: number, resourceId: number): void {
  const db = getDb()
  const resource = getVideoResourceById(resourceId)
  if (!resource || resource.video_id !== videoId) {
    throw new Error('资源不属于当前影片')
  }
  db.transaction(() => {
    db.prepare('UPDATE video_resources SET is_primary = 0 WHERE video_id = ?').run(videoId)
    db.prepare('UPDATE video_resources SET is_primary = 1 WHERE id = ?').run(resourceId)
  })()
}

export function updateLocalVideoResourceLabel(
  videoId: number,
  resourceId: number,
  displayName: string | null
): VideoResource {
  const db = getDb()
  const info = db
    .prepare(
      `UPDATE video_resources
       SET display_name = ?
       WHERE id = ? AND video_id = ? AND kind = 'local'`
    )
    .run(displayName, resourceId, videoId)
  if (info.changes === 0) throw new Error('本地影片资源不存在')
  const resource = getVideoResourceById(resourceId)
  if (!resource) throw new Error('本地影片资源更新失败')
  return resource
}

export function removeVideoResourceRecord(resourceId: number): void {
  getDb().prepare('DELETE FROM video_resources WHERE id = ?').run(resourceId)
}

export function importVideoLinkResourceRecord(input: {
  code: string
  kind: ExternalVideoResourceKind
  locator: string
  resourceKey: string
  displayName: string | null
  sizeBytes: number | null
}): VideoResourceImportResult | { duplicateOwnerCode: string } {
  const db = getDb()
  return db.transaction(() => {
    const duplicate = db
      .prepare(
        `SELECT v.code
         FROM video_resources vr
         JOIN videos v ON v.id = vr.video_id
         WHERE vr.resource_key = ?`
      )
      .get(input.resourceKey) as { code: string } | undefined
    if (duplicate) return { duplicateOwnerCode: duplicate.code }

    let video = getVideoByCode(input.code)
    const createdVideo = !video
    if (!video) {
      const info = db
        .prepare('INSERT INTO videos (code, scraped_status) VALUES (?, 0)')
        .run(input.code)
      video = { id: Number(info.lastInsertRowid), code: input.code }
    }
    const resourceCount = (
      db.prepare('SELECT COUNT(*) AS count FROM video_resources WHERE video_id = ?').get(video.id) as {
        count: number
      }
    ).count
    const info = db
      .prepare(
        `INSERT INTO video_resources (
           video_id, kind, locator, resource_key, size_bytes, display_name, is_primary, add_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        video.id,
        input.kind,
        input.locator,
        input.resourceKey,
        input.sizeBytes,
        input.displayName,
        resourceCount === 0 ? 1 : 0,
        nowIso()
      )
    const resource = getVideoResourceById(Number(info.lastInsertRowid))
    if (!resource) throw new Error('影片资源写入失败')
    return { videoId: video.id, resource, createdVideo }
  })()
}

export function updateVideoLinkResourceRecord(input: {
  resourceId: number
  videoId: number
  kind: ExternalVideoResourceKind
  locator: string
  resourceKey: string
  displayName: string | null
  sizeBytes: number | null
}): VideoResource | { duplicateOwnerCode: string } {
  const db = getDb()
  return db.transaction(() => {
    const duplicate = db
      .prepare(
        `SELECT v.code
         FROM video_resources vr
         JOIN videos v ON v.id = vr.video_id
         WHERE vr.resource_key = ? AND vr.id != ?`
      )
      .get(input.resourceKey, input.resourceId) as { code: string } | undefined
    if (duplicate) return { duplicateOwnerCode: duplicate.code }
    const info = db
      .prepare(
        `UPDATE video_resources
         SET kind = ?, locator = ?, resource_key = ?, display_name = ?, size_bytes = ?
         WHERE id = ? AND video_id = ? AND kind != 'local'`
      )
      .run(
        input.kind,
        input.locator,
        input.resourceKey,
        input.displayName,
        input.sizeBytes,
        input.resourceId,
        input.videoId
      )
    if (info.changes === 0) throw new Error('影片链接资源不存在')
    const resource = getVideoResourceById(input.resourceId)
    if (!resource) throw new Error('影片资源更新失败')
    return resource
  })()
}

export function getVideoById(id: number): Video | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as Video) ?? null
}

export function getVideoDetail(id: number): VideoDetail | null {
  const db = getDb()
  const video = getVideoById(id)
  if (!video) return null

  const actresses = db
    .prepare(
      `SELECT a.* FROM actresses a
       JOIN video_actress va ON va.actress_id = a.id
       WHERE va.video_id = ?
       ORDER BY CASE WHEN a.gender = 'male' THEN 1 ELSE 0 END, a.main_name`
    )
    .all(id) as VideoDetail['actresses']

  const tags = db
    .prepare(
      `SELECT t.*, vt.origin, vt.source FROM tags t
       JOIN video_tag vt ON vt.tag_id = t.id
       WHERE vt.video_id = ?
       ORDER BY CASE WHEN vt.origin = 'manual' THEN 1 ELSE 0 END, t.name`
    )
    .all(id) as VideoDetail['tags']

  const assets = db
    .prepare(
      `SELECT * FROM video_assets
       WHERE video_id = ?
       ORDER BY type, position, id`
    )
    .all(id) as VideoDetail['assets']

  const external_stats = db
    .prepare(
      `SELECT * FROM video_external_stats
       WHERE video_id = ?
       ORDER BY fetched_at DESC, source ASC`
    )
    .all(id) as VideoDetail['external_stats']

  const resources = listVideoResources(id)
  const files = listVideoFiles(id)
  const primaryResource = resources.find((resource) => Boolean(resource.is_primary))
  const primaryFile = files[0]
  return {
    ...video,
    primary_file_path: primaryFile?.file_path ?? null,
    file_count: files.length,
    primary_resource_kind: primaryResource?.kind ?? null,
    resource_count: resources.length,
    actresses,
    tags,
    assets,
    external_stats,
    files,
    resources
  }
}

export function addVideoSampleAsset(
  videoId: number,
  input: { remoteUrl?: string | null; localPath?: string | null }
): VideoAsset {
  if (!input.remoteUrl && !input.localPath) {
    throw new Error('样张来源不能为空')
  }
  const db = getDb()
  const position = (
    db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS n FROM video_assets WHERE video_id = ? AND type = 'sample'"
      )
      .get(videoId) as { n: number }
  ).n
  const createdAt = nowIso()
  const info = db
    .prepare(
      `INSERT INTO video_assets
         (video_id, type, position, remote_url, local_path, width, height, is_primary, created_at)
       VALUES (@videoId, 'sample', @position, @remoteUrl, @localPath, NULL, NULL, 0, @createdAt)`
    )
    .run({
      videoId,
      position,
      remoteUrl: input.remoteUrl ?? null,
      localPath: input.localPath ?? null,
      createdAt
    })
  return db
    .prepare('SELECT * FROM video_assets WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as VideoAsset
}

export function deleteVideoSampleAsset(
  videoId: number,
  assetId: number
): { obsoletePaths: string[] } {
  const db = getDb()
  const asset = db
    .prepare("SELECT local_path FROM video_assets WHERE id = ? AND video_id = ? AND type = 'sample'")
    .get(assetId, videoId) as { local_path: string | null } | undefined
  if (!asset) throw new Error('样张不存在')
  clearVideoPosterForPaths(videoId, [asset.local_path])
  db.prepare("DELETE FROM video_assets WHERE id = ? AND video_id = ? AND type = 'sample'").run(
    assetId,
    videoId
  )
  return { obsoletePaths: asset.local_path ? [asset.local_path] : [] }
}

/** Build a WHERE clause + bound params from a query object. */
function buildWhere(q: VideoQuery): { sql: string; params: unknown[]; joins: string } {
  const conditions: string[] = []
  const params: unknown[] = []
  let joins = ''

  if (q.search && q.search.trim()) {
    const like = `%${q.search.trim()}%`
    conditions.push(
      `(v.code LIKE ? OR v.title LIKE ? OR v.id IN (
       SELECT va.video_id FROM video_actress va
         JOIN actresses a ON a.id = va.actress_id
         WHERE ${actressOwnedNamePatternSearchSql('a')}
       ))`
    )
    params.push(like, like, like)
  }

  if (q.scrapedStatus !== undefined && q.scrapedStatus !== 'all') {
    conditions.push('v.scraped_status = ?')
    params.push(q.scrapedStatus)
  }

  if (q.minRating !== undefined && q.minRating > 0) {
    conditions.push('v.rating >= ?')
    params.push(q.minRating)
  }

  if (q.year !== undefined && q.year !== 'all') {
    conditions.push("strftime('%Y', v.release_date) = ?")
    params.push(String(q.year))
  }

  if (q.actressId !== undefined) {
    joins += ' JOIN video_actress vaf ON vaf.video_id = v.id'
    conditions.push('vaf.actress_id = ?')
    params.push(q.actressId)
  }

  if (q.tagId !== undefined) {
    joins += ' JOIN video_tag vtf ON vtf.video_id = v.id'
    conditions.push('vtf.tag_id = ?')
    params.push(q.tagId)
  }

  // Multi-tag AND filter: the video must carry every selected tag.
  if (q.tagIds && q.tagIds.length > 0) {
    const placeholders = q.tagIds.map(() => '?').join(',')
    conditions.push(
      `v.id IN (
         SELECT video_id FROM video_tag
         WHERE tag_id IN (${placeholders})
         GROUP BY video_id
         HAVING COUNT(DISTINCT tag_id) = ?
       )`
    )
    params.push(...q.tagIds, q.tagIds.length)
  }

  if (q.maker) {
    conditions.push('v.maker = ?')
    params.push(q.maker)
  }
  if (q.publisher) {
    conditions.push('v.publisher = ?')
    params.push(q.publisher)
  }
  if (q.series) {
    conditions.push('v.series = ?')
    params.push(q.series)
  }
  if (q.director) {
    conditions.push('v.director = ?')
    params.push(q.director)
  }

  if (q.codePrefix && q.codePrefix.trim()) {
    conditions.push('v.code LIKE ?')
    params.push(`${q.codePrefix.trim().toUpperCase()}-%`)
  }

  if (q.resourceKinds && q.resourceKinds.length > 0) {
    const kinds = Array.from(new Set(q.resourceKinds))
    const includeNone = kinds.includes('none')
    const concreteKinds = kinds.filter((kind) => kind !== 'none')
    const alternatives: string[] = []
    if (concreteKinds.length > 0) {
      alternatives.push(
        `EXISTS (
           SELECT 1 FROM video_resources vrf
           WHERE vrf.video_id = v.id
             AND vrf.kind IN (${concreteKinds.map(() => '?').join(',')})
         )`
      )
      params.push(...concreteKinds)
    }
    if (includeNone) {
      alternatives.push('NOT EXISTS (SELECT 1 FROM video_resources vrf WHERE vrf.video_id = v.id)')
    }
    if (alternatives.length > 0) conditions.push(`(${alternatives.join(' OR ')})`)
  }

  const sql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, params, joins }
}

const SORT_COLUMNS: Record<string, string> = {
  add_time: 'v.add_time',
  release_date: 'v.release_date',
  rating: 'v.rating',
  code: 'v.code'
}

function buildVideoListOrderBy(sortBy: string | undefined, sortDir: 'ASC' | 'DESC'): string {
  const key = sortBy ?? 'add_time'
  if (key === 'release_date') {
    return `(v.release_date IS NULL OR trim(v.release_date) = '') ASC, v.release_date ${sortDir}, v.add_time DESC`
  }
  if (key === 'rating') {
    return `v.rating ${sortDir}, v.add_time DESC`
  }
  const col = SORT_COLUMNS[key] ?? 'v.add_time'
  return `${col} ${sortDir}`
}

export function listVideos(q: VideoQuery = {}): VideoListResult {
  const db = getDb()
  const { sql: where, params, joins } = buildWhere(q)

  const totalRow = db
    .prepare(`SELECT COUNT(DISTINCT v.id) AS c FROM videos v ${joins} ${where}`)
    .get(...params) as { c: number }

  const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC'
  const orderBy = buildVideoListOrderBy(q.sortBy, sortDir)
  const limit = q.limit ?? 60
  const offset = q.offset ?? 0

  const rows = db
    .prepare(
      `SELECT DISTINCT v.*${videoListSelectExtras()} FROM videos v ${joins} ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as VideoListProjectionRow[]

  return { items: hydrateVideoListRows(rows), total: totalRow.c }
}

/** Distinct release years present in the library (descending). */
export function listYears(): number[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT DISTINCT strftime('%Y', release_date) AS y
       FROM videos WHERE release_date IS NOT NULL AND release_date != ''
       ORDER BY y DESC`
    )
    .all() as { y: string }[]
  return rows.map((r) => Number(r.y)).filter((n) => !Number.isNaN(n))
}

export function setRating(id: number, rating: number): void {
  const db = getDb()
  const clamped = Math.max(0, Math.min(5, Math.round(rating)))
  db.prepare('UPDATE videos SET rating = ? WHERE id = ?').run(clamped, id)
}

export function setVideoPosterPath(id: number, posterPath: string | null): void {
  const db = getDb()
  const normalized = posterPath?.trim() || null
  if (normalized) {
    const row = db
      .prepare(
        "SELECT 1 FROM video_assets WHERE video_id = ? AND type = 'sample' AND local_path = ?"
      )
      .get(id, normalized)
    if (!row) throw new Error('海报必须来自当前影片的本地样张')
  }
  db.prepare('UPDATE videos SET poster_path = ?, updated_at = ? WHERE id = ?').run(
    normalized,
    nowIso(),
    id
  )
}

export function deleteVideo(id: number): void {
  const db = getDb()
  db.prepare('DELETE FROM videos WHERE id = ?').run(id)
}

/** Allow editing a subset of user-facing fields manually. */
export function updateVideoFields(
  id: number,
  fields: Partial<
    Pick<
      Video,
      | 'title'
      | 'summary'
      | 'maker'
      | 'publisher'
      | 'series'
      | 'director'
      | 'release_date'
      | 'duration_seconds'
    >
  >
): void {
  const db = getDb()
  const keys = Object.keys(fields)
  if (!keys.length) return
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE videos SET ${assignments} WHERE id = @id`).run({ ...fields, id })
}

/** Replace tag relations for one origin only. */
function replaceTagsByOrigin(
  videoId: number,
  names: string[],
  origin: 'manual' | 'scraped',
  source: string | null,
  createdAt?: string
): void {
  const db = getDb()
  db.prepare('DELETE FROM video_tag WHERE video_id = ? AND origin = ?').run(videoId, origin)
  const stampedAt = createdAt ?? nowIso()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) continue
    const tagId = ensureTag(name)
    db.prepare(
      `INSERT OR IGNORE INTO video_tag
         (video_id, tag_id, origin, source, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(videoId, tagId, origin, source, stampedAt)
  }
}

export function addManualVideoTag(videoId: number, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('标签名称不能为空')
  const db = getDb()
  const tagId = ensureTag(trimmed)
  const existing = db
    .prepare('SELECT origin FROM video_tag WHERE video_id = ? AND tag_id = ?')
    .get(videoId, tagId) as { origin: string } | undefined

  if (existing?.origin === 'manual') return

  if (existing) {
    db.prepare(
      `UPDATE video_tag
       SET origin = 'manual', source = NULL, created_at = ?
       WHERE video_id = ? AND tag_id = ?`
    ).run(nowIso(), videoId, tagId)
  } else {
    db.prepare(
      `INSERT INTO video_tag
         (video_id, tag_id, origin, source, created_at)
       VALUES (?, ?, 'manual', NULL, ?)`
    ).run(videoId, tagId, nowIso())
  }

  db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(nowIso(), videoId)
}

export function removeManualVideoTag(videoId: number, tagId: number): void {
  const db = getDb()
  const removed = db
    .prepare('DELETE FROM video_tag WHERE video_id = ? AND tag_id = ? AND origin = ?')
    .run(videoId, tagId, 'manual')
  if (removed.changes > 0) {
    pruneTagIfUnused(tagId)
    db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(nowIso(), videoId)
  }
}


function listVideoAssetPaths(videoId: number, type: string): Array<string | null> {
  return getDb()
    .prepare(
      'SELECT local_path FROM video_assets WHERE video_id = ? AND type = ? ORDER BY position, id'
    )
    .all(videoId, type)
    .map((row) => (row as { local_path: string | null }).local_path)
}

export function getVideoImageCandidatePaths(videoId: number): {
  coverPath: string | null
  samplePaths: Array<string | null>
} {
  const coverPath = (getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as
    | { cover_path: string | null }
    | undefined)?.cover_path ?? null
  return { coverPath, samplePaths: listVideoAssetPaths(videoId, 'sample') }
}


/** Replace a video's cast from manual edit lists. */
function replaceVideoCast(
  videoId: number,
  femaleNames: string[],
  maleNames: string[]
): void {
  const db = getDb()
  db.prepare('DELETE FROM video_actress WHERE video_id = ?').run(videoId)
  for (const raw of femaleNames) {
    const name = raw.trim()
    if (!name) continue
    const actressId = upsertActressFromScrape(name, null, 'female')
    db.prepare('INSERT OR IGNORE INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
      videoId,
      actressId
    )
  }
  for (const raw of maleNames) {
    const name = raw.trim()
    if (!name) continue
    const actressId = upsertActressFromScrape(name, null, 'male')
    db.prepare('INSERT OR IGNORE INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
      videoId,
      actressId
    )
  }
}

/**
 * Manually edit metadata. Scalar fields are updated when present; scraped tags and
 * actresses, when supplied, fully replace existing relations for that origin.
 */
export function editVideoRecord(
  id: number,
  input: VideoEditInput,
  coverRelPath?: string
): { obsoletePaths: string[] } {
  const db = getDb()
  const cleanupHints = collectVideoLibraryCleanupHints(id)
  const previousCover = (db.prepare('SELECT cover_path FROM videos WHERE id = ?').get(id) as
    | { cover_path: string | null }
    | undefined)?.cover_path ?? null

  const scalarKeys = [
    'title',
    'summary',
    'release_date',
    'maker',
    'publisher',
    'series',
    'director',
    'duration_seconds',
    'rating'
  ] as const

  const txn = db.transaction(() => {
    const assignments: string[] = []
    const bind: Record<string, unknown> = { id }
    for (const key of scalarKeys) {
      if (key in input && input[key] !== undefined) {
        assignments.push(`${key} = @${key}`)
        bind[key] = input[key]
      }
    }
    if (assignments.length) {
      db.prepare(`UPDATE videos SET ${assignments.join(', ')} WHERE id = @id`).run(bind)
    }

    if ('tags' in input) replaceTagsByOrigin(id, input.tags ?? [], 'scraped', null)
    if ('actressesFemale' in input || 'actressesMale' in input) {
      replaceVideoCast(id, input.actressesFemale ?? [], input.actressesMale ?? [])
    }

    if (coverRelPath) {
      db.prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRelPath, id)
    }

    db.prepare('UPDATE videos SET updated_at = ? WHERE id = ?').run(nowIso(), id)

    // Promote to "scraped" once it has a title.
    const row = db.prepare('SELECT title FROM videos WHERE id = ?').get(id) as
      | { title: string | null }
      | undefined
    if (row && row.title && row.title.trim()) {
      db.prepare('UPDATE videos SET scraped_status = 1 WHERE id = ?').run(id)
    }

    const updated = db
      .prepare('SELECT maker, publisher, series, director FROM videos WHERE id = ?')
      .get(id) as {
        maker: string | null
        publisher: string | null
        series: string | null
        director: string | null
      }
    ensureFacetEntries(updated)
  })
  txn()
  try {
    runLibraryCleanup(cleanupHints)
  } catch (error) {
    console.error('Post-commit library cleanup failed:', error)
  }
  return {
    obsoletePaths:
      coverRelPath && previousCover && previousCover !== coverRelPath ? [previousCover] : []
  }
}

/**
 * Clear all scraped metadata for a video, resetting it to the un-scraped state.
 * Keeps the code, file path, custom rating and play stats; deletes the local cover
 * file, external site links/ratings, and removes actress/scraped-tag relations.
 */
export function clearVideoMetadataRecord(id: number): { obsoletePaths: string[] } {
  const db = getDb()
  const cleanupHints = collectVideoLibraryCleanupHints(id)

  let obsoletePaths: string[] = []
  const txn = db.transaction(() => {
    obsoletePaths = deleteVideoAssetRows(id)
    db.prepare(
      `UPDATE videos SET
         title = NULL, summary = NULL, cover_path = NULL, poster_path = NULL,
         original_title = NULL, release_date = NULL,
         maker = NULL, publisher = NULL, series = NULL, director = NULL,
         duration_seconds = NULL, last_scraped_at = NULL, updated_at = NULL,
         scraped_status = 0
       WHERE id = ?`
    ).run(id)
    db.prepare('DELETE FROM video_actress WHERE video_id = ?').run(id)
    db.prepare("DELETE FROM video_tag WHERE video_id = ? AND origin = 'scraped'").run(id)
    db.prepare('DELETE FROM video_external_ids WHERE video_id = ?').run(id)
    db.prepare('DELETE FROM video_external_stats WHERE video_id = ?').run(id)
  })
  txn()
  try {
    runLibraryCleanup(cleanupHints)
  } catch (error) {
    console.error('Post-commit library cleanup failed:', error)
  }
  return { obsoletePaths }
}

export function renameVideoCode(id: number, code: string): void {
  const db = getDb()
  db.prepare('UPDATE videos SET code = ? WHERE id = ?').run(code, id)
}

export function mergeVideoIntoExistingCode(sourceId: number, targetId: number): void {
  const db = getDb()
  const cleanupHints = collectVideoLibraryCleanupHints(sourceId)
  db.transaction(() => {
    const targetPrimary = getPrimaryVideoFile(targetId)
    const files = listVideoFiles(sourceId)
    for (const file of files) {
      const isPrimary = !targetPrimary && file.is_primary ? 1 : 0
      db.prepare('UPDATE video_resources SET video_id = ?, is_primary = ? WHERE id = ?').run(
        targetId,
        isPrimary,
        file.id
      )
    }
    deleteVideo(sourceId)
  })()
  runLibraryCleanup(cleanupHints)
}

/** Codes of all videos with scraped_status = 0 (used for batch scraping). */
export function listUnscrapedCodes(): { id: number; code: string }[] {
  return listVideosForBatchScrape({ status: 0 })
}

type VideoBatchTarget = { id: number; code: string }

function rematchScopeToBatchStatus(scope: VideoRematchScope): VideoBatchScrapeStatus {
  if (scope === 'scraped') return 1
  if (scope === 'failed') return 2
  return 'all'
}

function buildBatchScrapeWhere(filter: VideoBatchScrapeFilter): {
  sql: string
  params: unknown[]
} {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filter.videoIds) {
    const videoIds = Array.from(
      new Set(filter.videoIds.map((id) => Number(id)).filter((id) => Number.isFinite(id)))
    )
    if (videoIds.length === 0) {
      conditions.push('0')
    } else {
      conditions.push(`v.id IN (${videoIds.map(() => '?').join(', ')})`)
      params.push(...videoIds)
    }
  }

  if (filter.status !== 'all') {
    conditions.push('v.scraped_status = ?')
    params.push(filter.status)
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

/** Videos eligible for unified batch scraping/updating. */
export function listVideosForBatchScrape(
  filter: VideoBatchScrapeFilter
): VideoBatchTarget[] {
  const db = getDb()
  const { sql: where, params } = buildBatchScrapeWhere(filter)
  return db
    .prepare(`SELECT v.id, v.code FROM videos v ${where} ORDER BY v.add_time`)
    .all(...params) as VideoBatchTarget[]
}

export function countVideosForBatchScrape(
  filter: VideoBatchScrapeFilter
): number {
  return listVideosForBatchScrape(filter).length
}

/** Videos eligible for batch rematch (re-scrape selected fields from a chosen site). */
export function listVideosForRematch(scope: VideoRematchScope): VideoBatchTarget[] {
  return listVideosForBatchScrape({ status: rematchScopeToBatchStatus(scope) })
}

export function countVideosForRematch(scope: VideoRematchScope): number {
  return countVideosForBatchScrape({ status: rematchScopeToBatchStatus(scope) })
}

export function markScrapeFailed(id: number): void {
  const db = getDb()
  db.prepare('UPDATE videos SET scraped_status = 2 WHERE id = ? AND scraped_status != 1').run(id)
}

export function markScrapeSucceeded(id: number): void {
  const db = getDb()
  const scrapedAt = nowIso()
  db.prepare(
    `UPDATE videos
        SET scraped_status = 1,
            last_scraped_at = COALESCE(last_scraped_at, @scrapedAt),
            updated_at = @scrapedAt
      WHERE id = @id`
  ).run({ id, scrapedAt })
}


/** Update stored relative asset paths after encrypt/decrypt migration. */
export function remapAssetPath(oldRel: string, newRel: string): void {
  const db = getDb()
  db.prepare('UPDATE videos SET cover_path = ? WHERE cover_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE videos SET poster_path = ? WHERE poster_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE actresses SET avatar_path = ? WHERE avatar_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE actresses SET avatar_source_path = ? WHERE avatar_source_path = ?').run(
    newRel,
    oldRel
  )
  db.prepare('UPDATE actresses SET poster_path = ? WHERE poster_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE playlists SET cover_path = ? WHERE cover_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE video_assets SET local_path = ? WHERE local_path = ?').run(newRel, oldRel)
  db.prepare('UPDATE actress_gallery_assets SET local_path = ? WHERE local_path = ?').run(
    newRel,
    oldRel
  )
}



function deleteVideoAssetRows(videoId: number): string[] {
  const db = getDb()
  const rows = db
    .prepare('SELECT local_path FROM video_assets WHERE video_id = ?')
    .all(videoId) as { local_path: string | null }[]
  db.prepare('UPDATE videos SET poster_path = NULL WHERE id = ?').run(videoId)
  db.prepare('DELETE FROM video_assets WHERE video_id = ?').run(videoId)
  return rows.flatMap((row) => row.local_path ? [row.local_path] : [])
}

function clearVideoPosterForPaths(videoId: number, paths: Array<string | null>): void {
  const db = getDb()
  const clear = db.prepare('UPDATE videos SET poster_path = NULL WHERE id = ? AND poster_path = ?')
  for (const path of paths) {
    if (path) clear.run(videoId, path)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
