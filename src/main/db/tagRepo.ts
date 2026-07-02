import { getDb } from './database'
import type { Tag } from '@shared/types'

/** Find or create a tag, returning its id. */
export function ensureTag(name: string): number {
  const db = getDb()
  const trimmed = name.trim()
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (existing) return existing.id
  const info = db.prepare('INSERT INTO tags (name) VALUES (?)').run(trimmed)
  return Number(info.lastInsertRowid)
}

export interface TagListItem extends Tag {
  video_count: number
}

export function listTags(): TagListItem[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT t.*, COUNT(vt.video_id) AS video_count
       FROM tags t
       LEFT JOIN video_tag vt ON vt.tag_id = t.id
       GROUP BY t.id
       ORDER BY video_count DESC, t.name`
    )
    .all() as TagListItem[]
}

/** Tags that appear as custom/manual on at least one video. */
export function listManualTags(): TagListItem[] {
  const db = getDb()
  return db
    .prepare(
      `SELECT t.*, COUNT(DISTINCT vt.video_id) AS video_count
       FROM tags t
       JOIN video_tag vt ON vt.tag_id = t.id AND vt.origin = 'manual'
       GROUP BY t.id
       ORDER BY video_count DESC, t.name`
    )
    .all() as TagListItem[]
}

/** Drop tag row when it has no video associations left (e.g. last manual link removed). */
export function pruneTagIfUnused(tagId: number): void {
  const db = getDb()
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM video_tag WHERE tag_id = ?')
    .get(tagId) as { n: number }
  if (row.n === 0) {
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId)
  }
}
