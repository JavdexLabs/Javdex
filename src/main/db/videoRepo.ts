import { getDb } from './database'
import type {
  ActressGender,
  Video,
  VideoFile,
  VideoAsset,
  VideoDetail,
  VideoQuery,
  VideoListResult,
  ScrapeResult,
  ScrapedActress,
  VideoEditInput,
  VideoBatchScrapeFilter,
  VideoBatchScrapeStatus,
  VideoScrapeField,
  VideoScrapeUpdateMode,
  VideoRematchScope
} from '@shared/types'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/types'
import { upsertActressFromScrape } from './actressRepo'
import { actressSearchLikeParams, actressTextSearchSql } from './actressSearchSql'
import { ensureTag, pruneTagIfUnused } from './tagRepo'
import { ensureFacetEntries } from './facetRepo'
import { collectVideoLibraryCleanupHints, runLibraryCleanup } from './libraryCleanup'
import { deleteAsset } from '../services/assetService'

export interface NewVideo {
  code: string
  file_path: string
  file_size: number | null
  file_duration_seconds?: number | null
  file_mtime_ms?: number | null
}

const PRIMARY_FILE_ORDER = 'ORDER BY is_primary DESC, id ASC'

function listFileSelectExtras(): string {
  return `,
    (SELECT vf.file_path FROM video_files vf WHERE vf.video_id = v.id ${PRIMARY_FILE_ORDER} LIMIT 1) AS primary_file_path,
    (SELECT COUNT(*) FROM video_files vf WHERE vf.video_id = v.id) AS file_count`
}

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
    db.prepare('UPDATE video_files SET is_primary = 0 WHERE video_id = ?').run(input.video_id)
  }
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO video_files
         (video_id, file_path, file_size, file_duration_seconds, file_mtime_ms, label, is_primary, add_time)
       VALUES (@video_id, @file_path, @file_size, @file_duration_seconds, @file_mtime_ms, @label, @is_primary, @add_time)`
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
  const row = db.prepare('SELECT 1 FROM video_files WHERE file_path = ?').get(filePath)
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
  return (db.prepare('SELECT * FROM video_files WHERE id = ?').get(fileId) as VideoFile) ?? null
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
    `UPDATE video_files
     SET file_duration_seconds = ?, file_size = ?, file_mtime_ms = ?
     WHERE id = ?`
  ).run(input.file_duration_seconds, input.file_size, input.file_mtime_ms, fileId)
}

export function backfillVideoFileFingerprint(
  fileId: number,
  input: { file_size: number | null; file_mtime_ms: number | null }
): void {
  const db = getDb()
  db.prepare('UPDATE video_files SET file_size = ?, file_mtime_ms = ? WHERE id = ?').run(
    input.file_size,
    input.file_mtime_ms,
    fileId
  )
}

export function getVideoFileByPath(filePath: string): VideoFile | null {
  const db = getDb()
  return (db.prepare('SELECT * FROM video_files WHERE file_path = ?').get(filePath) as VideoFile) ?? null
}

export function getPrimaryVideoFile(videoId: number): VideoFile | null {
  const db = getDb()
  return (
    (db
      .prepare(`SELECT * FROM video_files WHERE video_id = ? ${PRIMARY_FILE_ORDER} LIMIT 1`)
      .get(videoId) as VideoFile | undefined) ?? null
  )
}

export function listVideoFiles(videoId: number): VideoFile[] {
  const db = getDb()
  return db
    .prepare(`SELECT * FROM video_files WHERE video_id = ? ${PRIMARY_FILE_ORDER}, id ASC`)
    .all(videoId) as VideoFile[]
}

export function countVideoFiles(videoId: number): number {
  const db = getDb()
  return (db.prepare('SELECT COUNT(*) AS n FROM video_files WHERE video_id = ?').get(videoId) as { n: number })
    .n
}

export function setPrimaryVideoFile(videoId: number, fileId: number): void {
  const db = getDb()
  const file = getVideoFileById(fileId)
  if (!file || file.video_id !== videoId) {
    throw new Error('File not found for this video')
  }
  db.transaction(() => {
    db.prepare('UPDATE video_files SET is_primary = 0 WHERE video_id = ?').run(videoId)
    db.prepare('UPDATE video_files SET is_primary = 1 WHERE id = ?').run(fileId)
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
      `UPDATE video_files
       SET file_path = ?, file_size = ?, file_duration_seconds = ?, file_mtime_ms = ?
       WHERE id = ?`
    ).run(filePath, fileSize, fileDurationSeconds, fileMtimeMs, primary.id)
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
export function purgeVideo(id: number): void {
  const hints = collectVideoLibraryCleanupHints(id)
  const video = getVideoById(id)
  if (!video) return
  deleteVideoAssets(id)
  deleteAsset(video.cover_path)
  deleteVideo(id)
  runLibraryCleanup(hints)
}

/** Remove one file row; purge the video work when no files remain. */
export function purgeVideoFile(fileId: number): void {
  const file = getVideoFileById(fileId)
  if (!file) return
  const videoId = file.video_id
  const db = getDb()
  db.prepare('DELETE FROM video_files WHERE id = ?').run(fileId)
  if (countVideoFiles(videoId) === 0) {
    purgeVideo(videoId)
  }
}

export function listVideoFileRefs(): { video_id: number; file_id: number; file_path: string }[] {
  const db = getDb()
  return db
    .prepare('SELECT id AS file_id, video_id, file_path FROM video_files')
    .all() as { video_id: number; file_id: number; file_path: string }[]
}

/** Delete a file row without purging the parent video. */
export function removeVideoFileRecord(fileId: number): void {
  const db = getDb()
  db.prepare('DELETE FROM video_files WHERE id = ?').run(fileId)
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

  const files = listVideoFiles(id)
  const primary = files[0]
  return {
    ...video,
    primary_file_path: primary?.file_path ?? null,
    file_count: files.length,
    actresses,
    tags,
    assets,
    external_stats,
    files
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

export function deleteVideoSampleAsset(videoId: number, assetId: number): string | null {
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
  return asset.local_path
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
         WHERE ${actressTextSearchSql('a')}
       ))`
    )
    params.push(like, like, ...actressSearchLikeParams(q.search))
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

  const items = db
    .prepare(
      `SELECT DISTINCT v.*${listFileSelectExtras()} FROM videos v ${joins} ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Video[]

  return { items, total: totalRow.c }
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

function scrapedCastGender(a: ScrapedActress): ActressGender {
  return a.gender ?? 'female'
}

/** Remove cast links for one gender only (NULL gender is treated as female). */
function removeVideoActressesByGender(videoId: number, gender: ActressGender): void {
  const db = getDb()
  if (gender === 'female') {
    db.prepare(
      `DELETE FROM video_actress
       WHERE video_id = ?
         AND actress_id IN (
           SELECT id FROM actresses WHERE gender IS NULL OR gender = 'female'
         )`
    ).run(videoId)
  } else {
    db.prepare(
      `DELETE FROM video_actress
       WHERE video_id = ?
         AND actress_id IN (SELECT id FROM actresses WHERE gender = 'male')`
    ).run(videoId)
  }
}

function linkScrapedCastByGender(
  videoId: number,
  cast: ScrapedActress[],
  gender: ActressGender,
  actressAvatars: Map<string, string | null>
): void {
  const db = getDb()
  for (const a of cast) {
    if (scrapedCastGender(a) !== gender) continue
    const actressId = upsertActressFromScrape(
      a.name,
      actressAvatars.get(a.name) ?? null,
      gender
    )
    db.prepare('INSERT OR IGNORE INTO video_actress (video_id, actress_id) VALUES (?, ?)').run(
      videoId,
      actressId
    )
  }
}

function isBlankText(value: string | null | undefined): boolean {
  return value == null || value.trim() === ''
}

function countVideoCast(videoId: number): number {
  const db = getDb()
  return (
    db.prepare('SELECT COUNT(*) AS n FROM video_actress WHERE video_id = ?').get(videoId) as {
      n: number
    }
  ).n
}

function countScrapedVideoTags(videoId: number): number {
  const db = getDb()
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM video_tag WHERE video_id = ? AND origin = ?')
      .get(videoId, 'scraped') as { n: number }
  ).n
}

function countVideoExternalIds(videoId: number): number {
  const db = getDb()
  return (
    db.prepare('SELECT COUNT(*) AS n FROM video_external_ids WHERE video_id = ?').get(videoId) as {
      n: number
    }
  ).n
}

function countVideoExternalStats(videoId: number): number {
  const db = getDb()
  return (
    db.prepare('SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = ?').get(videoId) as {
      n: number
    }
  ).n
}

function countVideoAssetsByType(videoId: number, type: string): number {
  const db = getDb()
  return (
    db.prepare('SELECT COUNT(*) AS n FROM video_assets WHERE video_id = ? AND type = ?').get(
      videoId,
      type
    ) as { n: number }
  ).n
}

function isVideoFieldEmptyForFill(
  video: Video,
  field: VideoScrapeField,
  castCount: number,
  tagCount: number
): boolean {
  switch (field) {
    case 'title':
      return isBlankText(video.title)
    case 'summary':
      return isBlankText(video.summary)
    case 'cover':
      return isBlankText(video.cover_path)
    case 'releaseDate':
      return isBlankText(video.release_date)
    case 'maker':
      return isBlankText(video.maker)
    case 'publisher':
      return isBlankText(video.publisher)
    case 'series':
      return isBlankText(video.series)
    case 'director':
      return isBlankText(video.director)
    case 'duration':
      return video.duration_seconds == null
    case 'actressesFemale':
    case 'actressesMale':
      return castCount === 0
    case 'tags':
      return tagCount === 0
    case 'source':
      return countVideoExternalIds(video.id) === 0
    case 'rating':
      return countVideoExternalStats(video.id) === 0
    case 'samples':
      return countVideoAssetsByType(video.id, 'sample') === 0
    default:
      return false
  }
}

/**
 * In fillEmpty mode, keep only selected fields that are currently empty on the video.
 * Cast fields apply only when the video has no linked performers (no female and no male).
 */
export function resolveEffectiveScrapeFields(
  videoId: number,
  fields: VideoScrapeField[],
  mode: VideoScrapeUpdateMode = 'replace'
): VideoScrapeField[] {
  if (mode !== 'fillEmpty') return fields
  const video = getVideoById(videoId)
  if (!video) return []
  const castCount = countVideoCast(videoId)
  const tagCount = countScrapedVideoTags(videoId)
  return fields.filter((field) => isVideoFieldEmptyForFill(video, field, castCount, tagCount))
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
): void {
  const db = getDb()
  const cleanupHints = collectVideoLibraryCleanupHints(id)

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
  runLibraryCleanup(cleanupHints)
}

/**
 * Clear all scraped metadata for a video, resetting it to the un-scraped state.
 * Keeps the code, file path, custom rating and play stats; deletes the local cover
 * file, external site links/ratings, and removes actress/scraped-tag relations.
 */
export function clearVideoMetadataRecord(id: number): void {
  const db = getDb()
  const cleanupHints = collectVideoLibraryCleanupHints(id)
  deleteVideoAssets(id)

  const txn = db.transaction(() => {
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
  runLibraryCleanup(cleanupHints)
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
      db.prepare('UPDATE video_files SET video_id = ?, is_primary = ? WHERE id = ?').run(
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

function videoMissingFieldCondition(field: VideoScrapeField): string {
  switch (field) {
    case 'title':
      return "(v.title IS NULL OR trim(v.title) = '')"
    case 'summary':
      return "(v.summary IS NULL OR trim(v.summary) = '')"
    case 'cover':
      return "(v.cover_path IS NULL OR trim(v.cover_path) = '')"
    case 'releaseDate':
      return "(v.release_date IS NULL OR trim(v.release_date) = '')"
    case 'maker':
      return "(v.maker IS NULL OR trim(v.maker) = '')"
    case 'publisher':
      return "(v.publisher IS NULL OR trim(v.publisher) = '')"
    case 'series':
      return "(v.series IS NULL OR trim(v.series) = '')"
    case 'director':
      return "(v.director IS NULL OR trim(v.director) = '')"
    case 'duration':
      return 'v.duration_seconds IS NULL'
    case 'actressesFemale':
    case 'actressesMale':
      return 'NOT EXISTS (SELECT 1 FROM video_actress va WHERE va.video_id = v.id)'
    case 'tags':
      return "NOT EXISTS (SELECT 1 FROM video_tag vt WHERE vt.video_id = v.id AND vt.origin = 'scraped')"
    case 'source':
      return 'NOT EXISTS (SELECT 1 FROM video_external_ids vei WHERE vei.video_id = v.id)'
    case 'rating':
      return 'NOT EXISTS (SELECT 1 FROM video_external_stats ves WHERE ves.video_id = v.id)'
    case 'samples':
      return "NOT EXISTS (SELECT 1 FROM video_assets vas WHERE vas.video_id = v.id AND vas.type = 'sample')"
    default:
      return '0'
  }
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

  const missingFields = Array.from(new Set(filter.missingFields ?? []))
  if (missingFields.length > 0) {
    conditions.push(`(${missingFields.map(videoMissingFieldCondition).join(' OR ')})`)
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
}

/** Videos eligible for unified batch scraping/updating. */
export function listVideosForBatchScrape(filter: VideoBatchScrapeFilter): VideoBatchTarget[] {
  const db = getDb()
  const { sql: where, params } = buildBatchScrapeWhere(filter)
  return db
    .prepare(`SELECT v.id, v.code FROM videos v ${where} ORDER BY v.add_time`)
    .all(...params) as VideoBatchTarget[]
}

export function countVideosForBatchScrape(filter: VideoBatchScrapeFilter): number {
  const db = getDb()
  const { sql: where, params } = buildBatchScrapeWhere(filter)
  return (db.prepare(`SELECT COUNT(*) AS n FROM videos v ${where}`).get(...params) as { n: number })
    .n
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

/**
 * Apply a scrape result to a video, link actresses/tags, and store cover path.
 * Wrapped in a transaction so a partial failure doesn't corrupt relations.
 */
export function applyScrapeResult(
  videoId: number,
  result: ScrapeResult,
  coverRelPath: string | null,
  actressAvatars: Map<string, string | null>,
  sampleRelPaths: Array<string | null> = [],
  fields?: VideoScrapeField[],
  sourceName?: string,
  mode: VideoScrapeUpdateMode = 'replace',
  ratingSourceName?: string
): boolean {
  const db = getDb()
  const requested = fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const effective = resolveEffectiveScrapeFields(videoId, requested, mode)
  if (effective.length === 0) return false

  const selected = new Set(effective)
  const existing = getVideoById(videoId)
  const cleanupHints = collectVideoLibraryCleanupHints(videoId)
  const scrapedAt = nowIso()
  /** fillEmpty / replaceIfPresent keep old values when scrape returns null; replace overwrites with scrape (including null). */
  const preserveOnNull = mode !== 'replace'

  const txn = db.transaction(() => {
    const assignments: string[] = []
    const bind: Record<string, unknown> = { id: videoId }

    const setScalar = (column: string, bindKey: string, value: unknown): void => {
      assignments.push(
        preserveOnNull ? `${column} = COALESCE(@${bindKey}, ${column})` : `${column} = @${bindKey}`
      )
      bind[bindKey] = value
    }

    if (selected.has('title')) {
      const title = result.title ?? null
      setScalar('title', 'title', title)
      setScalar('original_title', 'original_title', title)
    }
    if (selected.has('summary')) {
      setScalar('summary', 'summary', result.summary ?? null)
    }
    if (selected.has('cover')) {
      if (coverRelPath) {
        assignments.push('cover_path = @cover_path')
        bind.cover_path = coverRelPath
      } else if (!preserveOnNull) {
        assignments.push('cover_path = NULL')
      }
    }
    if (selected.has('releaseDate')) {
      setScalar('release_date', 'release_date', result.releaseDate ?? null)
    }
    if (selected.has('maker')) {
      setScalar('maker', 'maker', result.maker ?? null)
    }
    if (selected.has('publisher')) {
      setScalar('publisher', 'publisher', result.publisher ?? null)
    }
    if (selected.has('series')) {
      setScalar('series', 'series', result.series ?? null)
    }
    if (selected.has('director')) {
      setScalar('director', 'director', result.director ?? null)
    }
    if (selected.has('duration')) {
      setScalar('duration_seconds', 'duration_seconds', result.durationSeconds ?? null)
    }

    if (assignments.length > 0) {
      assignments.push('scraped_status = 1')
      assignments.push('last_scraped_at = @last_scraped_at')
      assignments.push('updated_at = @updated_at')
      bind.last_scraped_at = scrapedAt
      bind.updated_at = scrapedAt
      db.prepare(`UPDATE videos SET ${assignments.join(', ')} WHERE id = @id`).run(bind)
    } else if (
      selected.has('actressesFemale') ||
      selected.has('actressesMale') ||
      selected.has('tags') ||
      selected.has('source') ||
      selected.has('rating') ||
      selected.has('samples')
    ) {
      db.prepare(
        'UPDATE videos SET scraped_status = 1, last_scraped_at = ?, updated_at = ? WHERE id = ?'
      ).run(scrapedAt, scrapedAt, videoId)
    }

    const cast = result.actresses ?? []
    const femaleCastCount = cast.filter((a) => scrapedCastGender(a) === 'female').length
    const maleCastCount = cast.filter((a) => scrapedCastGender(a) === 'male').length

    if (selected.has('actressesFemale') && (mode === 'replace' || femaleCastCount > 0)) {
      removeVideoActressesByGender(videoId, 'female')
      linkScrapedCastByGender(videoId, cast, 'female', actressAvatars)
    }
    if (selected.has('actressesMale') && (mode === 'replace' || maleCastCount > 0)) {
      removeVideoActressesByGender(videoId, 'male')
      linkScrapedCastByGender(videoId, cast, 'male', actressAvatars)
    }

    if (selected.has('tags') && (mode === 'replace' || (result.tags?.length ?? 0) > 0)) {
      replaceTagsByOrigin(videoId, result.tags ?? [], 'scraped', sourceName ?? null, scrapedAt)
    }

    ensureFacetEntries({
      maker: selected.has('maker') ? (result.maker ?? null) : null,
      publisher: selected.has('publisher') ? (result.publisher ?? null) : null,
      series: selected.has('series') ? (result.series ?? null) : null,
      director: selected.has('director') ? (result.director ?? null) : null
    })

    if (coverRelPath) {
      upsertVideoAsset(videoId, {
        type: 'cover',
        position: 0,
        remoteUrl: result.coverUrl ?? null,
        localPath: coverRelPath,
        isPrimary: 1,
        createdAt: scrapedAt
      })
    }

    if (selected.has('samples')) {
      if (result.sampleImageUrls?.length) {
        replaceVideoAssets(
          videoId,
          'sample',
          result.sampleImageUrls.map((url, index) => ({
            type: 'sample',
            position: index,
            remoteUrl: url,
            localPath: sampleRelPaths[index] ?? null,
            isPrimary: 0,
            createdAt: scrapedAt
          }))
        )
      } else if (!preserveOnNull) {
        replaceVideoAssets(videoId, 'sample', [])
      }
    }

    if (sourceName && selected.has('source')) {
      upsertVideoExternalId(videoId, sourceName, result, scrapedAt)
    }

    const statsSource = ratingSourceName ?? sourceName
    if (statsSource && selected.has('rating')) {
      if (result.ratingAverage !== undefined || result.ratingCount !== undefined) {
        upsertVideoExternalStats(videoId, statsSource, result, scrapedAt)
      } else if (!preserveOnNull) {
        deleteVideoExternalStats(videoId, statsSource)
      }
    }
  })

  txn()

  if (selected.has('cover') && existing?.cover_path) {
    if (coverRelPath && existing.cover_path !== coverRelPath) {
      deleteAsset(existing.cover_path)
    } else if (!coverRelPath && !preserveOnNull) {
      deleteAsset(existing.cover_path)
    }
  }

  runLibraryCleanup(cleanupHints)
  return true
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

function upsertVideoAsset(
  videoId: number,
  asset: {
    type: string
    position: number
    remoteUrl: string | null
    localPath: string | null
    isPrimary: number
    createdAt: string
  }
): void {
  const db = getDb()
  if (asset.isPrimary) {
    db.prepare('UPDATE video_assets SET is_primary = 0 WHERE video_id = ? AND type = ?').run(
      videoId,
      asset.type
    )
  }
  db.prepare(
    `INSERT INTO video_assets
       (video_id, type, position, remote_url, local_path, is_primary, created_at)
     VALUES (@videoId, @type, @position, @remoteUrl, @localPath, @isPrimary, @createdAt)`
  ).run({ videoId, ...asset })
}

function replaceVideoAssets(
  videoId: number,
  type: string,
  assets: Array<{
    type: string
    position: number
    remoteUrl: string | null
    localPath: string | null
    isPrimary: number
    createdAt: string
  }>
): void {
  const db = getDb()
  const old = db
    .prepare('SELECT local_path FROM video_assets WHERE video_id = ? AND type = ?')
    .all(videoId, type) as { local_path: string | null }[]
  clearVideoPosterForPaths(videoId, old.map((row) => row.local_path))
  for (const row of old) deleteAsset(row.local_path)
  db.prepare('DELETE FROM video_assets WHERE video_id = ? AND type = ?').run(videoId, type)
  for (const asset of assets) {
    upsertVideoAsset(videoId, asset)
  }
}

function upsertVideoExternalId(
  videoId: number,
  source: string,
  result: ScrapeResult,
  fetchedAt: string
): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO video_external_ids
       (video_id, source, external_id, external_code, url, title, fetched_at)
     VALUES (@videoId, @source, @externalId, @externalCode, @url, @title, @fetchedAt)
     ON CONFLICT(video_id, source) DO UPDATE SET
       external_id = excluded.external_id,
       external_code = excluded.external_code,
       url = excluded.url,
       title = excluded.title,
       fetched_at = excluded.fetched_at`
  ).run({
    videoId,
    source,
    externalId: null,
    externalCode: result.code || null,
    url: result.sourceUrl ?? null,
    title: result.title ?? null,
    fetchedAt
  })
}

function upsertVideoExternalStats(
  videoId: number,
  source: string,
  result: ScrapeResult,
  fetchedAt: string
): void {
  if (result.ratingAverage === undefined && result.ratingCount === undefined) return
  const db = getDb()
  db.prepare(
    `INSERT INTO video_external_stats
       (video_id, source, rating_average, rating_count, fetched_at)
     VALUES (@videoId, @source, @ratingAverage, @ratingCount, @fetchedAt)
     ON CONFLICT(video_id, source) DO UPDATE SET
       rating_average = excluded.rating_average,
       rating_count = excluded.rating_count,
       fetched_at = excluded.fetched_at`
  ).run({
    videoId,
    source,
    ratingAverage: result.ratingAverage ?? null,
    ratingCount: result.ratingCount ?? null,
    fetchedAt
  })
}

function deleteVideoExternalStats(videoId: number, source: string): void {
  const db = getDb()
  db.prepare('DELETE FROM video_external_stats WHERE video_id = ? AND source = ?').run(
    videoId,
    source
  )
}

function deleteVideoAssets(videoId: number): void {
  const db = getDb()
  const rows = db
    .prepare('SELECT local_path FROM video_assets WHERE video_id = ?')
    .all(videoId) as { local_path: string | null }[]
  db.prepare('UPDATE videos SET poster_path = NULL WHERE id = ?').run(videoId)
  for (const row of rows) deleteAsset(row.local_path)
  db.prepare('DELETE FROM video_assets WHERE video_id = ?').run(videoId)
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
