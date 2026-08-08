import { getDb } from './database'
import type { ActressGender } from '@shared/actressTypes'
import type { Video, VideoFile, VideoAsset, VideoDetail, VideoQuery, VideoListResult, VideoEditInput } from '@shared/videoTypes'
import type { ScrapeResult, ScrapedActress, VideoBatchScrapeFilter, VideoBatchScrapeStatus, VideoScrapeField, VideoScrapeUpdateMode, VideoRematchScope } from '@shared/videoScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { upsertActressFromScrape } from './actressRepo'
import { actressOwnedNamePatternSearchSql } from './actressSearchSql'
import { ensureTag, pruneTagIfUnused } from './tagRepo'
import { ensureFacetEntries } from './facetRepo'
import { collectVideoLibraryCleanupHints, runLibraryCleanup } from './libraryCleanup'
export interface VideoImageAvailabilityFacts {
  coverAvailable?: boolean
  samplePathsAvailable?: boolean
}

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
  db.prepare('DELETE FROM video_files WHERE id = ?').run(fileId)
  if (countVideoFiles(videoId) === 0) {
    return purgeVideo(videoId)
  }
  return { obsoletePaths: [] }
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

function countVideoCastByGender(videoId: number, gender: ActressGender): number {
  const db = getDb()
  const condition =
    gender === 'female' ? "(a.gender = 'female' OR a.gender IS NULL)" : "a.gender = 'male'"
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM video_actress va
         JOIN actresses a ON a.id = va.actress_id
         WHERE va.video_id = ? AND ${condition}`
      )
      .get(videoId) as { n: number }
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

function countVideoExternalIds(videoId: number, sourceName?: string): number {
  const db = getDb()
  const row = sourceName
    ? db
        .prepare(
          "SELECT COUNT(*) AS n FROM video_external_ids WHERE video_id = ? AND source = ? AND url IS NOT NULL AND trim(url) != ''"
        )
        .get(videoId, sourceName)
    : db
        .prepare(
          "SELECT COUNT(*) AS n FROM video_external_ids WHERE video_id = ? AND url IS NOT NULL AND trim(url) != ''"
        )
        .get(videoId)
  return (row as { n: number }).n
}

function countVideoExternalStats(videoId: number, sourceName?: string): number {
  const db = getDb()
  const row = sourceName
    ? db
        .prepare(
          'SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = ? AND source = ? AND rating_average IS NOT NULL'
        )
        .get(videoId, sourceName)
    : db
        .prepare(
          'SELECT COUNT(*) AS n FROM video_external_stats WHERE video_id = ? AND rating_average IS NOT NULL'
        )
        .get(videoId)
  return (row as { n: number }).n
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

function isVideoFieldEmptyForFill(
  video: Video,
  field: VideoScrapeField,
  femaleCastCount: number,
  maleCastCount: number,
  tagCount: number,
  sourceName?: string,
  ratingSourceName?: string,
  imageFacts: VideoImageAvailabilityFacts = {}
): boolean {
  switch (field) {
    case 'title':
      return isBlankText(video.title)
    case 'summary':
      return isBlankText(video.summary)
    case 'cover':
      return !(imageFacts.coverAvailable ?? Boolean(video.cover_path?.trim()))
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
      return femaleCastCount === 0
    case 'actressesMale':
      return maleCastCount === 0
    case 'tags':
      return tagCount === 0
    case 'source':
      return countVideoExternalIds(video.id, sourceName) === 0
    case 'rating':
      return countVideoExternalStats(video.id, ratingSourceName ?? sourceName) === 0
    case 'samples': {
      const paths = listVideoAssetPaths(video.id, 'sample')
      return paths.length === 0 || !(imageFacts.samplePathsAvailable ?? paths.every(Boolean))
    }
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
  mode: VideoScrapeUpdateMode = 'replace',
  sourceName?: string,
  ratingSourceName?: string,
  imageFacts: VideoImageAvailabilityFacts = {}
): VideoScrapeField[] {
  if (mode !== 'fillEmpty') return fields
  const video = getVideoById(videoId)
  if (!video) return []
  const requested = new Set(fields)
  const femaleCastCount = requested.has('actressesFemale')
    ? countVideoCastByGender(videoId, 'female')
    : 0
  const maleCastCount = requested.has('actressesMale')
    ? countVideoCastByGender(videoId, 'male')
    : 0
  const tagCount = requested.has('tags') ? countScrapedVideoTags(videoId) : 0
  return fields.filter((field) =>
    isVideoFieldEmptyForFill(
      video,
      field,
      femaleCastCount,
      maleCastCount,
      tagCount,
      sourceName,
      ratingSourceName,
      imageFacts
    )
  )
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
  const candidates = db
    .prepare(`SELECT v.id, v.code FROM videos v ${where} ORDER BY v.add_time`)
    .all(...params) as VideoBatchTarget[]
  const missingFields = Array.from(new Set(filter.missingFields ?? []))
  if (missingFields.length === 0) return candidates
  return candidates.filter(
    (video) =>
      resolveEffectiveScrapeFields(
        video.id,
        missingFields,
        'fillEmpty',
        filter.sourceName,
        filter.ratingSourceName
      ).length > 0
  )
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

export type VideoScrapeImpactAction = 'preserve' | 'set' | 'replace' | 'clear'
export type VideoScrapeImpactReason =
  | 'replace'
  | 'fillEmpty'
  | 'replaceIfPresent'
  | 'existingValue'
  | 'noValue'
  | 'resourceUnavailable'

export interface VideoScrapeFieldImpact {
  field: VideoScrapeField
  action: VideoScrapeImpactAction
  reason: VideoScrapeImpactReason
  currentValue: unknown
  nextValue: unknown
  sourceName?: string
}

export interface VideoScrapeApplicationPlan {
  effectiveFields: VideoScrapeField[]
  impacts: VideoScrapeFieldImpact[]
  shouldApply: boolean
  warnings: string[]
}

function normalizedScrapeText(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

/** Build a read-only field plan before any database row or asset reference is changed. */
export function planVideoScrapeResult(
  videoId: number,
  result: ScrapeResult,
  coverRelPath: string | null,
  sampleRelPaths: Array<string | null> = [],
  fields?: VideoScrapeField[],
  sourceName?: string,
  mode: VideoScrapeUpdateMode = 'replace',
  ratingSourceName?: string,
  imageFacts: VideoImageAvailabilityFacts = {}
): VideoScrapeApplicationPlan {
  const requested = fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const effectiveFields = resolveEffectiveScrapeFields(
    videoId,
    requested,
    mode,
    sourceName,
    ratingSourceName,
    imageFacts
  )
  const effective = new Set(effectiveFields)
  const video = getVideoById(videoId)
  const warnings: string[] = []
  const cast = result.actresses ?? []
  const sampleUrls = (result.sampleImageUrls ?? []).filter((url) =>
    Boolean(normalizedScrapeText(url))
  )
  const samplesReady =
    sampleUrls.length > 0 &&
    sampleRelPaths.length === sampleUrls.length &&
    sampleRelPaths.every((assetPath) => Boolean(assetPath))
  const coverUnavailable =
    effective.has('cover') && Boolean(normalizedScrapeText(result.coverUrl)) && !coverRelPath
  const samplesUnavailable = effective.has('samples') && sampleUrls.length > 0 && !samplesReady
  if (coverUnavailable) warnings.push('封面下载失败，已保留原封面')
  if (samplesUnavailable) warnings.push('样张下载不完整，已保留原样张')

  const durationValue =
    typeof result.durationSeconds === 'number' &&
    Number.isFinite(result.durationSeconds) &&
    result.durationSeconds >= 0
      ? result.durationSeconds
      : null
  const ratingValue =
    typeof result.ratingAverage === 'number' && Number.isFinite(result.ratingAverage)
      ? result.ratingAverage
      : null
  const values = new Map<VideoScrapeField, unknown>([
    ['title', normalizedScrapeText(result.title)],
    ['summary', normalizedScrapeText(result.summary)],
    ['cover', coverRelPath],
    ['releaseDate', normalizedScrapeText(result.releaseDate)],
    ['maker', normalizedScrapeText(result.maker)],
    ['publisher', normalizedScrapeText(result.publisher)],
    ['series', normalizedScrapeText(result.series)],
    ['director', normalizedScrapeText(result.director)],
    ['duration', durationValue],
    ['actressesFemale', cast.filter((item) => scrapedCastGender(item) === 'female')],
    ['actressesMale', cast.filter((item) => scrapedCastGender(item) === 'male')],
    ['tags', result.tags ?? []],
    ['source', normalizedScrapeText(result.sourceUrl)],
    ['rating', ratingValue],
    ['samples', samplesReady ? sampleRelPaths : []]
  ])
  const currentValues = new Map<VideoScrapeField, unknown>([
    ['title', video?.title ?? null],
    ['summary', video?.summary ?? null],
    ['cover', video?.cover_path ?? null],
    ['releaseDate', video?.release_date ?? null],
    ['maker', video?.maker ?? null],
    ['publisher', video?.publisher ?? null],
    ['series', video?.series ?? null],
    ['director', video?.director ?? null],
    ['duration', video?.duration_seconds ?? null],
    ['actressesFemale', countVideoCastByGender(videoId, 'female')],
    ['actressesMale', countVideoCastByGender(videoId, 'male')],
    ['tags', countScrapedVideoTags(videoId)],
    ['source', countVideoExternalIds(videoId, sourceName)],
    ['rating', countVideoExternalStats(videoId, ratingSourceName ?? sourceName)],
    ['samples', listVideoAssetPaths(videoId, 'sample')]
  ])

  const impacts = requested.map((field): VideoScrapeFieldImpact => {
    const nextValue = values.get(field) ?? null
    const isCollection = Array.isArray(nextValue)
    const hasValue = isCollection ? nextValue.length > 0 : nextValue !== null && nextValue !== undefined
    const resourceUnavailable =
      (field === 'cover' && coverUnavailable) || (field === 'samples' && samplesUnavailable)
    const missingFieldSource =
      (field === 'source' && !sourceName) ||
      (field === 'rating' && !(ratingSourceName ?? sourceName))
    let action: VideoScrapeImpactAction = 'preserve'
    let reason: VideoScrapeImpactReason = effective.has(field) ? 'noValue' : 'existingValue'
    if (effective.has(field) && missingFieldSource) {
      reason = 'noValue'
    } else if (effective.has(field) && resourceUnavailable) {
      reason = 'resourceUnavailable'
    } else if (effective.has(field) && mode === 'replace') {
      action = hasValue ? 'replace' : 'clear'
      reason = 'replace'
    } else if (effective.has(field) && hasValue) {
      action = mode === 'fillEmpty' ? 'set' : 'replace'
      reason = mode
    }
    return {
      field,
      action,
      reason,
      currentValue: currentValues.get(field) ?? null,
      nextValue,
      sourceName:
        field === 'rating'
          ? (ratingSourceName ?? sourceName)
          : field === 'source'
            ? sourceName
            : undefined
    }
  })

  return {
    effectiveFields,
    impacts,
    shouldApply: impacts.some((impact) => impact.action !== 'preserve'),
    warnings
  }
}

/**
 * Apply a scrape result to a video, link actresses/tags, and store cover path.
 * Wrapped in a transaction so a partial failure doesn't corrupt relations.
 */
export interface ApplyVideoScrapeResult {
  applied: boolean
  warnings: string[]
  obsoleteAssetPaths: string[]
}

export function applyScrapeResult(
  videoId: number,
  result: ScrapeResult,
  coverRelPath: string | null,
  actressAvatars: Map<string, string | null>,
  sampleRelPaths: Array<string | null> = [],
  fields?: VideoScrapeField[],
  sourceName?: string,
  mode: VideoScrapeUpdateMode = 'replace',
  ratingSourceName?: string,
  imageFacts: VideoImageAvailabilityFacts = {}
): ApplyVideoScrapeResult {
  const db = getDb()
  const requested = fields ?? ALL_VIDEO_SCRAPE_FIELDS
  const plan = planVideoScrapeResult(
    videoId,
    result,
    coverRelPath,
    sampleRelPaths,
    requested,
    sourceName,
    mode,
    ratingSourceName,
    imageFacts
  )
  if (!plan.shouldApply) return { applied: false, warnings: plan.warnings, obsoleteAssetPaths: [] }

  const impactFor = (field: VideoScrapeField): VideoScrapeFieldImpact | undefined =>
    plan.impacts.find((impact) => impact.field === field)
  const impactAction = (field: VideoScrapeField): VideoScrapeImpactAction =>
    impactFor(field)?.action ?? 'preserve'
  const writesField = (field: VideoScrapeField): boolean => impactAction(field) !== 'preserve'
  const existing = getVideoById(videoId)
  if (!existing) return { applied: false, warnings: [], obsoleteAssetPaths: [] }
  const cleanupHints = collectVideoLibraryCleanupHints(videoId)
  const scrapedAt = nowIso()
  const warnings = plan.warnings
  const scalarColumns: Partial<Record<VideoScrapeField, { column: string; bindKey: string }>> = {
    title: { column: 'title', bindKey: 'title' },
    summary: { column: 'summary', bindKey: 'summary' },
    releaseDate: { column: 'release_date', bindKey: 'release_date' },
    maker: { column: 'maker', bindKey: 'maker' },
    publisher: { column: 'publisher', bindKey: 'publisher' },
    series: { column: 'series', bindKey: 'series' },
    director: { column: 'director', bindKey: 'director' },
    duration: { column: 'duration_seconds', bindKey: 'duration_seconds' }
  }
  const scalarWrites = plan.impacts.flatMap((impact) => {
    const metadata = scalarColumns[impact.field]
    return metadata && impact.action !== 'preserve'
      ? [{ field: impact.field, value: impact.nextValue, ...metadata }]
      : []
  })

  const cast = result.actresses ?? []
  const writeFemale = writesField('actressesFemale')
  const writeMale = writesField('actressesMale')
  const writeTags = writesField('tags')

  const sourceUrl = (impactFor('source')?.nextValue as string | null | undefined) ?? null
  const writeSource = Boolean(sourceName && writesField('source'))
  const ratingValue = (impactFor('rating')?.nextValue as number | null | undefined) ?? null
  const statsSource = ratingSourceName ?? sourceName
  const writeRating = Boolean(statsSource && writesField('rating'))

  const writeCover = writesField('cover')

  const sampleUrls = (result.sampleImageUrls ?? []).filter((url) =>
    Boolean(normalizedScrapeText(url))
  )
  const writeSamples = writesField('samples')

  const oldAssetPaths: Array<string | null> = []

  const txn = db.transaction(() => {
    const assignments: string[] = []
    const bind: Record<string, unknown> = { id: videoId }

    for (const { field, column, bindKey, value } of scalarWrites) {
      assignments.push(`${column} = @${bindKey}`)
      bind[bindKey] = value
      if (field === 'title') {
        assignments.push('original_title = @original_title')
        bind.original_title = value
      }
    }

    if (writeCover) {
      assignments.push('cover_path = @cover_path')
      bind.cover_path = coverRelPath
      oldAssetPaths.push(existing.cover_path)
      oldAssetPaths.push(
        ...replaceVideoAssets(
          videoId,
          'cover',
          coverRelPath
            ? [
                {
                  type: 'cover',
                  position: 0,
                  remoteUrl: result.coverUrl ?? null,
                  localPath: coverRelPath,
                  isPrimary: 1,
                  createdAt: scrapedAt
                }
              ]
            : []
        )
      )
    }

    if (assignments.length > 0) {
      db.prepare(`UPDATE videos SET ${assignments.join(', ')} WHERE id = @id`).run(bind)
    }

    if (writeFemale) {
      removeVideoActressesByGender(videoId, 'female')
      linkScrapedCastByGender(videoId, cast, 'female', actressAvatars)
    }
    if (writeMale) {
      removeVideoActressesByGender(videoId, 'male')
      linkScrapedCastByGender(videoId, cast, 'male', actressAvatars)
    }

    if (writeTags) {
      replaceTagsByOrigin(videoId, result.tags ?? [], 'scraped', sourceName ?? null, scrapedAt)
    }

    ensureFacetEntries({
      maker: writesField('maker') ? (result.maker ?? null) : null,
      publisher: writesField('publisher') ? (result.publisher ?? null) : null,
      series: writesField('series') ? (result.series ?? null) : null,
      director: writesField('director') ? (result.director ?? null) : null
    })

    if (writeSamples) {
      oldAssetPaths.push(
        ...replaceVideoAssets(
          videoId,
          'sample',
          sampleUrls.map((url, index) => ({
            type: 'sample',
            position: index,
            remoteUrl: url,
            localPath: sampleRelPaths[index]!,
            isPrimary: 0,
            createdAt: scrapedAt
          }))
        )
      )
    }

    if (writeSource && sourceName) {
      if (sourceUrl) upsertVideoExternalId(videoId, sourceName, result, scrapedAt)
      else deleteVideoExternalId(videoId, sourceName)
    }

    if (writeRating && statsSource) {
      if (ratingValue !== null) {
        upsertVideoExternalStats(videoId, statsSource, result, scrapedAt)
      } else {
        deleteVideoExternalStats(videoId, statsSource)
      }
    }

    db.prepare(
      'UPDATE videos SET scraped_status = 1, last_scraped_at = ?, updated_at = ? WHERE id = ?'
    ).run(scrapedAt, scrapedAt, videoId)
  })

  txn()

  const obsoleteAssetPaths = Array.from(new Set(oldAssetPaths)).filter(
    (assetPath): assetPath is string =>
      Boolean(assetPath && assetPath !== coverRelPath && !sampleRelPaths.includes(assetPath))
  )

  try {
    runLibraryCleanup(cleanupHints)
  } catch (error) {
    console.error('Post-commit library cleanup failed:', error)
  }
  return { applied: true, warnings, obsoleteAssetPaths }
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
): Array<string | null> {
  const db = getDb()
  const old = db
    .prepare('SELECT local_path FROM video_assets WHERE video_id = ? AND type = ?')
    .all(videoId, type) as { local_path: string | null }[]
  clearVideoPosterForPaths(videoId, old.map((row) => row.local_path))
  db.prepare('DELETE FROM video_assets WHERE video_id = ? AND type = ?').run(videoId, type)
  for (const asset of assets) {
    upsertVideoAsset(videoId, asset)
  }
  return old.map((row) => row.local_path)
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

function deleteVideoExternalId(videoId: number, source: string): void {
  getDb()
    .prepare('DELETE FROM video_external_ids WHERE video_id = ? AND source = ?')
    .run(videoId, source)
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
