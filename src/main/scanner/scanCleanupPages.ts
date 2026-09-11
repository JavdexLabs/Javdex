import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

export const SCAN_CLEANUP_PAGE_SIZE = 128
export type CleanupCandidates = 'resources' | 'pendingScan' | 'pendingIdentity' | 'memberships' | 'unrecognized' | 'pendingGroups'
const tables = {
  resources: ['video_resources', 'id'],
  pendingGroups: ['pending_scan_groups', 'id'],
  pendingScan: ['pending_scan_resources', 'id'],
  pendingIdentity: ['pending_resource_identities', 'id'],
  memberships: ['library_video_memberships', 'video_id'],
  unrecognized: ['library_unrecognized_files', 'rowid']
} as const

/** Fixed high waters, plus insertion exclusions for tables without monotonic identities.
 * Pages are read and revalidated by the caller in one synchronous transaction. No
 * cursor/transaction survives the yield. TEMP state is only a live-run workset.
 * Insertion exclusions cover this application writer connection, not external writers.
 * Resource/pending IDs are AUTOINCREMENT; composite-key tables need the triggers.
 */
export function createScanCleanupPages(db: Database.Database, libraryId: number) {
  if (db.inTransaction) throw new Error('Cleanup pages cannot start in a transaction')
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) throw new Error('Invalid cleanup library')
  const prefix = `scan_cleanup_${randomUUID().replaceAll('-', '')}`
  const high = {} as Record<CleanupCandidates, number>
  db.transaction(() => {
    db.exec(`CREATE TEMP TABLE ${prefix}(kind TEXT, key TEXT, PRIMARY KEY(kind,key)) WITHOUT ROWID;
      CREATE TEMP TRIGGER ${prefix}_membership AFTER INSERT ON main.library_video_memberships
        WHEN NEW.library_id=${libraryId} BEGIN
          INSERT OR IGNORE INTO ${prefix} VALUES('memberships',CAST(NEW.video_id AS TEXT));
        END;
      CREATE TEMP TRIGGER ${prefix}_unrecognized AFTER INSERT ON main.library_unrecognized_files
        WHEN NEW.library_id=${libraryId} BEGIN
          INSERT OR IGNORE INTO ${prefix} VALUES('unrecognized',NEW.normalized_path);
        END;
      CREATE TEMP TRIGGER ${prefix}_membership_update AFTER UPDATE OF library_id,video_id ON main.library_video_memberships
        WHEN NEW.library_id=${libraryId} AND (NEW.library_id<>OLD.library_id OR NEW.video_id<>OLD.video_id) BEGIN
          INSERT OR IGNORE INTO ${prefix} VALUES('memberships',CAST(NEW.video_id AS TEXT));
        END;
      CREATE TEMP TRIGGER ${prefix}_unrecognized_update AFTER UPDATE ON main.library_unrecognized_files
        WHEN NEW.library_id=${libraryId} BEGIN
          INSERT OR IGNORE INTO ${prefix} VALUES('unrecognized',NEW.normalized_path);
        END;`)
    for (const kind of Object.keys(tables) as CleanupCandidates[]) {
      const [table, key] = tables[kind]
      high[kind] = (db.prepare(`SELECT COALESCE(MAX(${key}),0) AS id FROM ${table} WHERE library_id=?`)
        .get(libraryId) as { id: number }).id
    }
  })()
  let disposed = false
  return {
    resourceHighWater: high.resources,
    async each<T>(kind: CleanupCandidates, signal: AbortSignal, transaction: <R>(fn: () => R) => R,
      apply: (ids: number[]) => T, committed: (value: T) => void): Promise<boolean> {
      const [table, key] = tables[kind]
      const exclusion = kind === 'memberships' ? 'CAST(candidate.video_id AS TEXT)'
        : kind === 'unrecognized' ? 'candidate.normalized_path' : undefined
      const read = db.prepare(`SELECT candidate.${key} AS id FROM ${table} candidate ${kind === 'memberships' ? '' : 'NOT INDEXED'}
        WHERE library_id=? AND candidate.${key}>? AND candidate.${key}<=?
        ${exclusion ? `AND NOT EXISTS (SELECT 1 FROM temp.${prefix} excluded WHERE excluded.kind='${kind}' AND excluded.key=${exclusion})` : ''}
        ORDER BY candidate.${key} LIMIT ${SCAN_CLEANUP_PAGE_SIZE}`)
      let after = 0
      while (true) {
        if (signal.aborted) return false
        if (disposed || !db.open || db.inTransaction) throw new Error('Cleanup page lifecycle violation')
        let ids: number[] = []
        const value = transaction(() => {
          ids = (read.all(libraryId, after, high[kind]) as { id: number }[]).map(row => row.id)
          return apply(ids)
        })
        committed(value)
        if (!ids.length) return true
        after = ids[ids.length - 1]
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    },
    dispose() {
      if (disposed) return
      if (db.open) {
        if (db.inTransaction) throw new Error('Cleanup pages cannot close in a transaction')
        db.transaction(() => {
          db.exec(`DROP TRIGGER IF EXISTS temp.${prefix}_membership;
            DROP TRIGGER IF EXISTS temp.${prefix}_unrecognized;
            DROP TRIGGER IF EXISTS temp.${prefix}_membership_update;
            DROP TRIGGER IF EXISTS temp.${prefix}_unrecognized_update;
            DROP TABLE IF EXISTS temp.${prefix};`)
        })()
      }
      disposed = true
    }
  }
}
