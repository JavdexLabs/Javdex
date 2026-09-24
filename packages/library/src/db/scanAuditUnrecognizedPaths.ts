import type Database from 'better-sqlite3'

/**
 * Lazily read immutable, sealed file outcomes during the caller's synchronous
 * publication transaction. Each query completes before yielding, so the caller
 * can authorize the path and write its replacement row without a busy cursor.
 * One-shot: create a fresh iterator for every publication attempt. Consume it
 * synchronously within one transaction; do not pause across transaction changes.
 * Does not own a connection/transaction or normalize/authorize filesystem paths.
 */
export function iterateScanAuditUnrecognizedPaths(
  db: Database.Database,
  scope: { libraryId: number; runId: string }
): IterableIterator<string> {
  const { libraryId, runId } = scope
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0 ||
      typeof runId !== 'string' || !runId || runId.length > 256) {
    throw new Error('Invalid scan audit scope')
  }
  return (function* () {
    const readScope = db.prepare(`SELECT r.library_id, r.status, m.state FROM library_scan_runs r
      JOIN library_scan_audit_manifests m ON m.run_id=r.id WHERE r.id=?`)
    const assertReadable = (): void => {
      if (!db.inTransaction) throw new Error('Unrecognized audit paths require a publication transaction')
      const row = readScope.get(runId) as
        { library_id: number; status: string; state: string } | undefined
      if (!row || row.library_id !== libraryId || row.state !== 'sealed' ||
          (row.status !== 'running' && row.status !== 'completed')) {
        throw new Error('Unrecognized audit paths require a scoped sealed audit')
      }
    }
    assertReadable()
    const next = db.prepare(`SELECT ordinal, entry_key AS filePath
      FROM library_scan_audit_entries
      WHERE run_id=? AND section='files' AND ordinal>?
        AND json_extract(entry_json,'$.outcome')='unrecognized'
      ORDER BY ordinal LIMIT 1`)
    let ordinal = -1
    for (;;) {
      assertReadable()
      const row = next.get(runId, ordinal) as { ordinal: number; filePath: string } | undefined
      if (!row) return
      ordinal = row.ordinal
      yield row.filePath
    }
  })()
}
