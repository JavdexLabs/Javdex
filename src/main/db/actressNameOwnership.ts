import { getDb } from './database'
import { normalizeActressName } from './actressNameNormalization'

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
