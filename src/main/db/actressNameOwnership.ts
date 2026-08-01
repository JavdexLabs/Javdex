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

/** Whether a normalized name can be declared by this actress without resolving pending claims. */
export function isActressNameOwnershipAvailable(name: string, actressId: number): boolean {
  const db = getDb()
  const normalizedName = normalizeActressName(name)
  const owner = db
    .prepare('SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?')
    .get(normalizedName) as { actress_id: number } | undefined
  if (owner && owner.actress_id !== actressId) return false
  const pending = db
    .prepare('SELECT 1 FROM pending_actress_name_claims WHERE normalized_name = ? LIMIT 1')
    .get(normalizedName)
  return !pending
}

/**
 * Reconcile one actress's declared name rows with the unique ownership index.
 * Call inside the same transaction that changes actress_names.
 */
export function synchronizeActressNameOwnership(actressId: number): void {
  const db = getDb()
  db.prepare(
    `DELETE FROM pending_actress_name_claims
     WHERE actress_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM actress_names an
         WHERE an.actress_id = pending_actress_name_claims.actress_id
           AND an.name = pending_actress_name_claims.name
           AND an.type = pending_actress_name_claims.type
       )`
  ).run(actressId)

  const rows = db
    .prepare('SELECT name FROM actress_names WHERE actress_id = ?')
    .all(actressId) as Array<{ name: string }>
  const names = rows.map((row) => ({ ...row, normalizedName: normalizeActressName(row.name) }))
  const pendingNames = new Set(
    (
      db
        .prepare('SELECT DISTINCT normalized_name FROM pending_actress_name_claims')
        .all() as Array<{ normalized_name: string }>
    ).map((claim) => claim.normalized_name)
  )
  const claimableNames = Array.from(
    new Set(
      names
        .filter((name) => !pendingNames.has(name.normalizedName))
        .map((name) => name.normalizedName)
    )
  )

  const findOwner = db.prepare(
    'SELECT actress_id FROM actress_name_ownership WHERE normalized_name = ?'
  )
  for (const name of names) {
    if (pendingNames.has(name.normalizedName)) continue
    const owner = findOwner.get(name.normalizedName) as { actress_id: number } | undefined
    if (owner && owner.actress_id !== actressId) {
      throw new Error(`名称「${name.name}」已被其他演员使用`)
    }
  }

  if (claimableNames.length === 0) {
    db.prepare('DELETE FROM actress_name_ownership WHERE actress_id = ?').run(actressId)
  } else {
    const placeholders = claimableNames.map(() => '?').join(', ')
    db.prepare(
      `DELETE FROM actress_name_ownership
       WHERE actress_id = ? AND normalized_name NOT IN (${placeholders})`
    ).run(actressId, ...claimableNames)
  }

  const claim = db.prepare(
    `INSERT INTO actress_name_ownership (normalized_name, actress_id)
     VALUES (?, ?)
     ON CONFLICT(normalized_name) DO NOTHING`
  )
  for (const normalizedName of claimableNames) claim.run(normalizedName, actressId)
}
