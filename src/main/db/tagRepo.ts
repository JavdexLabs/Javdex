import type Database from 'better-sqlite3'
import { getDb } from './database'
import type { TagLabel, TagListItem, TagOptionsPage, TagOptionsQuery, TagFilterOptionsPage } from '@shared/commonTypes'

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

export type { TagListItem }

/** Visible-library membership counts; shared members must not multiply relationships. */
function tagVisibleCountCte(manualOnly: boolean): string {
  return `WITH members AS MATERIALIZED (
       SELECT DISTINCT membership.video_id
       FROM library_video_memberships membership
       JOIN media_libraries library ON library.id = membership.library_id
       WHERE membership.is_hidden = 0 AND library.status = 'active'
     ), counts AS (
       SELECT vt.tag_id, COUNT(members.video_id) AS video_count
       FROM video_tag vt JOIN members ON members.video_id = vt.video_id
       ${manualOnly ? "WHERE vt.origin = 'manual'" : ''}
       GROUP BY vt.tag_id
     )`
}

function queryTags(manualOnly: boolean): TagListItem[] {
  // The uncorrelated manual-tag set also retains invisible-only associations.
  // A correlated EXISTS can repeatedly scan all manual links under skewed statistics.
  return getDb().prepare(
    `${tagVisibleCountCte(manualOnly)}
     SELECT t.*, COALESCE(counts.video_count, 0) AS video_count
     FROM tags t LEFT JOIN counts ON counts.tag_id = t.id
     ${manualOnly ? `WHERE t.id IN (
       SELECT manual_link.tag_id FROM video_tag manual_link
       WHERE manual_link.origin = 'manual'
     )` : ''}
     ORDER BY video_count DESC, t.name`
  ).all() as TagListItem[]
}

export function listTags(): TagListItem[] {
  return queryTags(false)
}

/** Tags with any manual association, including ones with no currently visible videos. */
export function listManualTags(): TagListItem[] {
  return queryTags(true)
}

/** Resolve only selected filter labels, without scanning relationships or computing counts. */
export function getTagLabels(ids: number[]): TagLabel[] {
  if (ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('标签名称查询最多接受100个有效ID')
  }
  const selected = [...new Set(ids)]
  if (selected.length === 0) return []
  // 100 labels of at most 129 code points keep even JSON-escaped control text below 96KiB.
  // Full names remain in the database; this DTO is only for filter-chip display.
  return getDb().prepare(`SELECT id,
    substr(name, 1, 128) || CASE WHEN length(name) > 128 THEN '…' ELSE '' END AS label
    FROM tags WHERE id IN (${selected.map(() => '?').join(',')}) ORDER BY id`
  ).all(...selected) as TagLabel[]
}

/** Validate raw input before folding; Unicode folding may expand beyond 500 chars. */
export function normalizeTagOptionsQuery(query: TagOptionsQuery): { limit: number; offset: number; search: string } {
  const limit = query.limit ?? 100
  const offset = query.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0
    || (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 500))) {
    throw new Error('无效的标签候选查询')
  }
  const search = (query.search ?? '').trim().toLowerCase()
  return { limit, offset, search }
}

/** Alphabetical manual-tag candidates, with no visibility counts or full-name payloads. */
export function listManualTagOptions(query: TagOptionsQuery): TagOptionsPage {
  const { limit, offset, search } = normalizeTagOptionsQuery(query)
  // Pin the existing tag-key path: skewed statistics can otherwise select origin
  // for every outer tag and repeatedly scan all manual relationships.
  const rows = getDb().prepare(`SELECT t.id,
      substr(t.name, 1, 128) || CASE WHEN length(t.name) > 128 THEN '…' ELSE '' END AS label
    FROM tags t
    WHERE ${search ? 'tag_name_contains_folded(t.name, ?) AND' : ''} EXISTS (
      SELECT 1 FROM video_tag vt INDEXED BY idx_video_tag_tag_id
      WHERE vt.tag_id = t.id AND vt.origin = 'manual'
    )
    ORDER BY t.name LIMIT ? OFFSET ?`
  ).all(...(search ? [search] : []), limit + 1, offset) as TagLabel[]
  return { items: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** Select a bounded name page before counting its visible associations. */
export function listTagFilterOptions(query: TagOptionsQuery, connection?: Database.Database): TagFilterOptionsPage {
  const { limit, offset, search } = normalizeTagOptionsQuery(query)
  const db = connection ?? getDb()
  return db.transaction(() => {
    const rows = db.prepare(`SELECT id,
      substr(name, 1, 128) || CASE WHEN length(name) > 128 THEN '…' ELSE '' END AS label
      FROM tags ${search ? 'WHERE tag_name_contains_folded(name, ?)' : ''}
      ORDER BY name, id LIMIT ? OFFSET ?`)
      .all(...(search ? [search] : []), limit + 1, offset) as TagLabel[]
    const page = rows.slice(0, limit)
    if (page.length === 0) return { items: [], hasMore: false }
    // video_tag PK makes each video/tag pair unique; EXISTS avoids counting
    // shared library memberships twice. All origins and zero-count tags remain.
    const counts = db.prepare(`SELECT vt.tag_id, COUNT(*) AS video_count
      FROM video_tag vt INDEXED BY idx_video_tag_tag_id
      WHERE vt.tag_id IN (${page.map(() => '?').join(',')}) AND EXISTS (
        SELECT 1 FROM library_video_memberships m JOIN media_libraries l ON l.id=m.library_id
        WHERE m.video_id=vt.video_id AND m.is_hidden=0 AND l.status='active'
      ) GROUP BY vt.tag_id`).all(...page.map(row => row.id)) as { tag_id: number; video_count: number }[]
    const byId = new Map(counts.map(row => [row.tag_id, row.video_count]))
    return { items: page.map(row => ({ ...row, video_count: byId.get(row.id) ?? 0 })), hasMore: rows.length > limit }
  })()
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

/** Remove every tag that is no longer linked to any video. */
export function pruneUnusedTags(): number {
  return getDb()
    .prepare(
      `DELETE FROM tags
       WHERE NOT EXISTS (SELECT 1 FROM video_tag WHERE video_tag.tag_id = tags.id)`
    )
    .run().changes
}
