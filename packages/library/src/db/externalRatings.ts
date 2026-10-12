import type Database from 'better-sqlite3'
import type { VideoEditInput, VideoExternalStats } from '@shared/videoTypes'
import { selectDefaultExternalRating } from '@shared/externalRatings'

/** Call inside the rating mutation's transaction. Never replaces a valid manual choice. */
export function ensureDefaultExternalRating(db: Database.Database, videoId: number): void {
  const ratings = db.prepare('SELECT * FROM video_external_stats WHERE video_id = ?')
    .all(videoId) as VideoExternalStats[]
  const selected = selectDefaultExternalRating(ratings)
  db.prepare('UPDATE video_external_stats SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE video_id = ?')
    .run(selected?.id ?? null, videoId)
}

/** Call inside the metadata transaction so validation failures roll back every field. */
export function editExternalRatings(
  db: Database.Database,
  videoId: number,
  input: NonNullable<VideoEditInput['externalRatings']>
): void {
  const ratings = db.prepare('SELECT * FROM video_external_stats WHERE video_id = ?')
    .all(videoId) as VideoExternalStats[]
  const originals = new Map(ratings.map((rating) => [rating.source, rating]))
  const deleted = new Set(input.deletedSources)
  const entries = input.entries ?? []
  if (entries.length > 200) throw new Error('一次最多编辑 200 个评分来源')
  const edited = new Set<string>()
  for (const entry of entries) {
    if (entry.originalSource === null) continue
    if (!originals.has(entry.originalSource)) throw new Error('外部评分已变化，请重新打开编辑')
    if (edited.has(entry.originalSource) || deleted.has(entry.originalSource)) {
      throw new Error('同一评分来源不能重复编辑或同时删除')
    }
    edited.add(entry.originalSource)
  }
  const occupied = new Set(ratings.filter((rating) => !deleted.has(rating.source) && !edited.has(rating.source))
    .map((rating) => rating.source))
  const normalized = entries.map((entry) => {
    const source = entry.source.trim()
    if (!source || source.length > 256) throw new Error('评分来源名称须为 1–256 个字符')
    if (occupied.has(source)) throw new Error('评分来源名称不能重复')
    occupied.add(source)
    if (entry.ratingAverage !== null && (!Number.isFinite(entry.ratingAverage) || entry.ratingAverage < 0)) {
      throw new Error('评分须为不小于 0 的有效数字')
    }
    if (entry.ratingCount !== null && (!Number.isSafeInteger(entry.ratingCount) || entry.ratingCount < 0)) {
      throw new Error('评分人数须为不小于 0 的整数')
    }
    return { ...entry, source }
  })
  const remove = db.prepare('DELETE FROM video_external_stats WHERE video_id = ? AND source = ?')
  // Remove edited keys together to allow atomic renames, including exchanging two names.
  for (const source of new Set([...deleted, ...edited])) remove.run(videoId, source)
  const insert = db.prepare(`INSERT INTO video_external_stats
    (id, video_id, source, rating_average, rating_count, fetched_at, is_default)
    VALUES (?, ?, ?, ?, ?, ?, 0)`)
  for (const entry of normalized) {
    const original = entry.originalSource === null ? undefined : originals.get(entry.originalSource)
    insert.run(original?.id ?? null, videoId, entry.source, entry.ratingAverage, entry.ratingCount, original?.fetched_at ?? null)
  }
  if (input.defaultSource !== null && !db.prepare(
    'SELECT id FROM video_external_stats WHERE video_id = ? AND source = ? AND rating_average IS NOT NULL'
  ).get(videoId, input.defaultSource)) {
    throw new Error('默认外部评分不存在，请重新选择')
  }
  db.prepare('UPDATE video_external_stats SET is_default = CASE WHEN source = ? THEN 1 ELSE 0 END WHERE video_id = ?')
    .run(input.defaultSource, videoId)
  ensureDefaultExternalRating(db, videoId)
}
