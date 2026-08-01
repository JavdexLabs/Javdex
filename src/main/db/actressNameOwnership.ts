import { getDb } from './database'

/** Build the global ownership key for a searchable actress name. */
export function normalizeActressName(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .replace(/\p{White_Space}+/gu, '')
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase())

  if (!normalized) throw new Error('演员名称不能为空')
  return normalized
}

/** Find the sole actress that owns a searchable name. Ambiguous migrated names have no owner. */
export function findActressIdByOwnedName(name: string): number | null {
  const normalizedName = normalizeActressName(name)
  const row = getDb()
    .prepare(
      `SELECT actress_id
       FROM actress_name_ownership
       WHERE normalized_name = ?`
    )
    .get(normalizedName) as { actress_id: number } | undefined
  return row?.actress_id ?? null
}
