import type { LibraryScanPendingGroupAuditEntry } from '@shared/libraryTypes'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getDb } from './database'

/** Only hydrate audit summary fields for referenced groups; stream their paths for exact Set matching. */
export function readPendingScanAuditEntries(
  libraryId: number,
  groupIds: ReadonlySet<number>,
  pendingPaths: ReadonlySet<string>
): LibraryScanPendingGroupAuditEntry[] {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) throw new Error('Invalid scan audit library')
  const db = getDb()
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM media_libraries WHERE id=?').get(libraryId)) throw new Error('媒体库不存在。')
    if (!groupIds.size) return []
    // IDs drive primary-key lookups, then SQLite orders only the selected groups.
    const groups = db.prepare(`SELECT g.id,g.normalized_code FROM json_each(?) selected
      CROSS JOIN pending_scan_groups g ON g.id=selected.value
      WHERE g.library_id=? ORDER BY g.updated_at,g.id`)
    const resources = db.prepare('SELECT file_path FROM pending_scan_resources WHERE library_id=? AND group_id=?')
    const result: LibraryScanPendingGroupAuditEntry[] = []
    for (const value of groups.iterate(JSON.stringify([...groupIds]), libraryId)) {
      const group = value as { id: number; normalized_code: string }
      let resourceCount = 0
      for (const entry of resources.iterate(libraryId, group.id)) {
        if (pendingPaths.has((entry as { file_path: string }).file_path)) resourceCount++
      }
      result.push({ groupId: group.id, normalizedCode: group.normalized_code, resourceCount })
    }
    return result
  })()
}

/**
 * Read final staged file outcomes without hydrating files or JS path/group sets.
 * The synchronous visitor shares this transaction (or its caller's outer write
 * transaction); a callback failure rolls back writes made during the visit.
 * SQL materializes a narrow TEMP snapshot, then each completed singleton .get
 * precedes the callback so nested writer savepoints never see a busy iterator.
 * One normalizedCode can still be large: the visitor/writer owns byte rejection;
 * this API does not truncate it or claim a byte bound on that singleton string.
 */
export function visitPendingScanAuditEntriesForRun(
  db: Database.Database,
  scope: { libraryId: number; runId: string },
  visit: (entry: LibraryScanPendingGroupAuditEntry) => void
): void {
  const { libraryId, runId } = scope
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0 ||
      typeof runId !== 'string' || !runId || runId.length > 256) throw new Error('Invalid scan audit scope')
  db.transaction(() => {
    const run = db.prepare(`SELECT r.library_id, r.status, m.state FROM library_scan_runs r
      LEFT JOIN library_scan_audit_manifests m ON m.run_id=r.id WHERE r.id=?`).get(runId) as
      { library_id: number; status: string; state: string | null } | undefined
    if (!run || run.library_id !== libraryId) throw new Error('Scan audit run does not belong to library')
    if (run.status !== 'running' || run.state !== 'collecting') throw new Error('Scan audit requires a running collecting run')
    // Generated SQL identifier, never caller input. CREATE is inside our
    // transaction/savepoint, so failure rolls it back without masking the error.
    const table = `pending_scan_audit_visit_${randomUUID().replaceAll('-', '')}`
    db.exec(`CREATE TEMP TABLE ${table} (
      ordinal INTEGER PRIMARY KEY, groupId INTEGER NOT NULL,
      normalizedCode TEXT NOT NULL, resourceCount INTEGER NOT NULL
    )`)
    db.prepare(`INSERT INTO temp.${table}(ordinal,groupId,normalizedCode,resourceCount)
      WITH referenced AS (
        SELECT DISTINCT json_extract(entry_json, '$.groupId') AS group_id
        FROM library_scan_audit_entries WHERE run_id=@runId AND section='files'
          AND json_extract(entry_json, '$.outcome')='pending'
          AND json_type(entry_json, '$.groupId')='integer'
          AND json_extract(entry_json, '$.groupId') BETWEEN 1 AND 9007199254740991
      )
      SELECT ROW_NUMBER() OVER (ORDER BY g.updated_at,g.id), g.id AS groupId, g.normalized_code AS normalizedCode,
        (SELECT COUNT(*) FROM pending_scan_resources r
          WHERE r.library_id=@libraryId AND r.group_id=g.id AND EXISTS (
            SELECT 1 FROM library_scan_audit_entries f
            WHERE f.run_id=@runId AND f.section='files'
              AND f.entry_key=r.file_path COLLATE BINARY
              AND json_extract(f.entry_json, '$.outcome')='pending'
          )) AS resourceCount
      FROM referenced selected CROSS JOIN pending_scan_groups g ON g.id=selected.group_id
      WHERE g.library_id=@libraryId ORDER BY g.updated_at,g.id`).run({ libraryId, runId })
    const read = db.prepare(`SELECT groupId,normalizedCode,resourceCount FROM temp.${table} WHERE ordinal=?`)
    for (let ordinal = 1; ; ordinal++) {
      const entry = read.get(ordinal) as LibraryScanPendingGroupAuditEntry | undefined
      if (!entry) break
      const returned: unknown = visit(entry)
      if (returned != null && (typeof returned === 'object' || typeof returned === 'function') &&
          typeof (returned as { then?: unknown }).then === 'function') {
        void Promise.resolve(returned).catch(() => {})
        throw new Error('Pending audit visitor must be synchronous')
      }
    }
    db.exec(`DROP TABLE temp.${table}`)
  })()
}
