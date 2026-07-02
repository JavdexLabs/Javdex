import { getDb } from './database'
import type { FacetType, FacetItem } from '@shared/types'

// Whitelist column mapping to prevent SQL injection via the facet type.
const COLUMN: Record<FacetType, string> = {
  maker: 'maker',
  publisher: 'publisher',
  series: 'series',
  director: 'director'
}

/** Register a facet value so it remains listable even when no video references it. */
export function ensureFacetEntry(type: FacetType, value: string | null | undefined): void {
  const trimmed = value?.trim()
  if (!trimmed) return
  const db = getDb()
  db.prepare('INSERT OR IGNORE INTO facet_entries (type, value) VALUES (?, ?)').run(type, trimmed)
}

export function ensureFacetEntries(values: Partial<Record<FacetType, string | null>>): void {
  for (const type of ['maker', 'publisher', 'series', 'director'] as FacetType[]) {
    ensureFacetEntry(type, values[type])
  }
}

/**
 * List facet values from the registry, with live video counts and a cover preview.
 */
export function listFacet(type: FacetType): FacetItem[] {
  const col = COLUMN[type]
  if (!col) return []
  const db = getDb()
  return db
    .prepare(
      `SELECT fe.value,
              COUNT(v.id) AS video_count,
              (
                SELECT v2.cover_path FROM videos v2
                WHERE v2.${col} = fe.value AND v2.cover_path IS NOT NULL
                ORDER BY v2.release_date DESC, v2.add_time DESC
                LIMIT 1
              ) AS cover_path
       FROM facet_entries fe
       LEFT JOIN videos v ON v.${col} = fe.value
       WHERE fe.type = ?
       GROUP BY fe.value
       ORDER BY video_count DESC, value`
    )
    .all(type) as FacetItem[]
}

/** Remove a facet registry entry when it has no linked videos. */
export function deleteFacetEntry(type: FacetType, value: string): void {
  const col = COLUMN[type]
  if (!col) throw new Error('无效的分类')
  const trimmed = value.trim()
  if (!trimmed) throw new Error('名称无效')

  const db = getDb()
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM videos WHERE ${col} = ?`)
    .get(trimmed) as { c: number }
  if (row.c > 0) throw new Error('仍有影片关联，无法删除')

  const info = db
    .prepare('DELETE FROM facet_entries WHERE type = ? AND value = ?')
    .run(type, trimmed)
  if (info.changes === 0) throw new Error('条目不存在')
}
