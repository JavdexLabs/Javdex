import type { ActressName } from '@shared/types'
import { getDb } from './database'

export const ACTRESS_NAME_TYPE = {
  MAIN: 'main',
  ALIAS: 'alias',
  ZH: 'zh',
  EN: 'en'
} as const

export const ACTRESS_NAME_ZH_TYPES = ['zh', 'chinese'] as const
export const ACTRESS_NAME_EN_TYPES = ['en', 'english', 'romaji'] as const

export function upsertActressName(
  actressId: number,
  name: string,
  type: string,
  locale: string | null,
  source: string | null,
  isPrimary: number
): void {
  const trimmed = name.trim()
  if (!trimmed) return
  const db = getDb()
  if (isPrimary) {
    db.prepare('UPDATE actress_names SET is_primary = 0 WHERE actress_id = ? AND type = ?').run(
      actressId,
      type
    )
  }
  db.prepare(
    `INSERT INTO actress_names (actress_id, name, type, locale, source, is_primary)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(actress_id, name, type) DO UPDATE SET
       locale = excluded.locale,
       source = excluded.source,
       is_primary = excluded.is_primary`
  ).run(actressId, trimmed, type, locale, source, isPrimary)
}

export function listActressNameRows(actressId: number): ActressName[] {
  return getDb()
    .prepare(
      `SELECT * FROM actress_names
       WHERE actress_id = ?
       ORDER BY is_primary DESC, type, name`
    )
    .all(actressId) as ActressName[]
}

function pickPrimaryNameByTypes(rows: ActressName[], types: readonly string[]): string | null {
  const typeSet = new Set(types)
  const match = rows.find((row) => typeSet.has(row.type))
  return match?.name?.trim() || null
}

export function getActressTypedName(
  actressId: number,
  kind: 'zh' | 'en',
  rows?: ActressName[]
): string | null {
  const nameRows = rows ?? listActressNameRows(actressId)
  return kind === 'zh'
    ? pickPrimaryNameByTypes(nameRows, ACTRESS_NAME_ZH_TYPES)
    : pickPrimaryNameByTypes(nameRows, ACTRESS_NAME_EN_TYPES)
}

export function listActressAliasNames(actressId: number, rows?: ActressName[]): string[] {
  const nameRows = rows ?? listActressNameRows(actressId)
  return nameRows
    .filter((row) => row.type === ACTRESS_NAME_TYPE.ALIAS)
    .map((row) => row.name)
}

export function clearActressNamesByTypes(actressId: number, types: readonly string[]): void {
  if (!types.length) return
  const db = getDb()
  const placeholders = types.map(() => '?').join(',')
  db.prepare(
    `DELETE FROM actress_names WHERE actress_id = ? AND type IN (${placeholders})`
  ).run(actressId, ...types)
}

export function setActressTypedName(
  actressId: number,
  kind: 'zh' | 'en',
  name: string | null | undefined
): void {
  const types = kind === 'zh' ? ACTRESS_NAME_ZH_TYPES : ACTRESS_NAME_EN_TYPES
  clearActressNamesByTypes(actressId, types)
  const trimmed = name?.trim()
  if (!trimmed) return
  upsertActressName(
    actressId,
    trimmed,
    kind === 'zh' ? ACTRESS_NAME_TYPE.ZH : ACTRESS_NAME_TYPE.EN,
    null,
    null,
    1
  )
}

export function setActressTypedNameIfEmpty(
  actressId: number,
  kind: 'zh' | 'en',
  name: string | null | undefined
): void {
  if (getActressTypedName(actressId, kind)) return
  setActressTypedName(actressId, kind, name)
}

export function findActressIdByStoredName(name: string): number | null {
  const db = getDb()
  const trimmed = name.trim()
  if (!trimmed) return null

  const main = db.prepare('SELECT id FROM actresses WHERE main_name = ?').get(trimmed) as
    | { id: number }
    | undefined
  if (main) return main.id

  const typed = db
    .prepare('SELECT actress_id FROM actress_names WHERE name = ? LIMIT 1')
    .get(trimmed) as { actress_id: number } | undefined
  return typed?.actress_id ?? null
}

export function mergeActressNameRows(keepId: number, mergeId: number): void {
  const db = getDb()
  setActressTypedNameIfEmpty(keepId, 'zh', getActressTypedName(mergeId, 'zh'))
  setActressTypedNameIfEmpty(keepId, 'en', getActressTypedName(mergeId, 'en'))

  db.prepare(
    `INSERT OR IGNORE INTO actress_names (actress_id, name, type, locale, source, is_primary)
     SELECT ?, name, type, locale, source, is_primary
     FROM actress_names
     WHERE actress_id = ? AND type NOT IN ('main')`
  ).run(keepId, mergeId)
}
