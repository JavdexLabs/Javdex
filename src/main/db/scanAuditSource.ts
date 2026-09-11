import type Database from 'better-sqlite3'
import { normalizeAudit } from '../scanner/libraryScanAuditValidation'

export type ScanAuditSourceSelection =
  | { libraryId: number; runId: string }
  | { libraryId: number; latest: true }

interface ScanAuditSource {
  format: 'json' | 'entries'
  libraryId: number
  runId: string
}

export function readScanAuditSource(
  db: Database.Database, selection: ScanAuditSourceSelection, projection: 'identity'
): ScanAuditSource | undefined
export function readScanAuditSource(
  db: Database.Database, selection: ScanAuditSourceSelection, projection: 'bytes'
): (ScanAuditSource & { bytes: number }) | undefined
export function readScanAuditSource(
  db: Database.Database, selection: ScanAuditSourceSelection, projection: 'body'
): (ScanAuditSource & { body: string }) | undefined
/**
 * Legacy non-NULL selection includes malformed/empty JSON and nonterminal runs.
 * Entries require a published V1 manifest and a finished terminal run. Selection
 * never falls back to an older audit because the selected payload is damaged.
 * Identity/bytes do not hydrate payloads. Entries bytes count stored UTF-8 meta
 * plus entry_bytes, NOT the size of a reconstructed compatibility document.
 * Only body reconstructs the full audit; invalid entries metadata/body throws.
 * Call inside a reader transaction to share its snapshot with later queries.
 * Multi-query body reads open their own transaction only when none is active.
 */
export function readScanAuditSource(
  db: Database.Database,
  selection: ScanAuditSourceSelection,
  projection: 'identity' | 'bytes' | 'body'
): (ScanAuditSource & { bytes?: number; body?: string }) | undefined {
  if (projection === 'body' && !db.inTransaction) {
    return db.transaction(() => readScanAuditSource(db, selection, 'body'))()
  }
  const columns = projection === 'body'
    ? ', CASE WHEN r.audit_json IS NOT NULL THEN r.audit_json ELSE m.meta_json END AS body, r.finished_at AS finishedAt'
    : projection === 'bytes'
      ? `, CASE WHEN r.audit_json IS NOT NULL THEN length(CAST(r.audit_json AS BLOB))
          ELSE length(CAST(m.meta_json AS BLOB)) + COALESCE((
            SELECT SUM(e.entry_bytes) FROM library_scan_audit_entries e WHERE e.run_id = r.id
          ), 0) END AS bytes`
      : ''
  const exact = 'runId' in selection
  const row = db.prepare(`SELECT r.id, CASE WHEN r.audit_json IS NOT NULL THEN 'json' ELSE 'entries' END AS format${columns}
    FROM library_scan_runs r LEFT JOIN library_scan_audit_manifests m ON m.run_id = r.id
    WHERE r.library_id = ? AND (r.audit_json IS NOT NULL OR (
      m.state = 'published' AND m.format_version = 1
      AND r.status IN ('completed', 'failed', 'cancelled', 'unavailable')
      AND r.finished_at IS NOT NULL AND length(r.finished_at) > 0
    ))${exact ? ' AND r.id = ?' : ' ORDER BY r.started_at DESC, r.id DESC LIMIT 1'}`)
    .get(...(exact ? [selection.libraryId, selection.runId] : [selection.libraryId])) as
      { id: string; format: 'json' | 'entries'; bytes?: number; body?: string; finishedAt?: string } | undefined
  if (!row) return undefined
  const source: ScanAuditSource = { format: row.format, libraryId: selection.libraryId, runId: row.id }
  if (projection === 'bytes') return { ...source, bytes: row.bytes! }
  if (projection === 'identity') return source
  if (row.format === 'json') return { ...source, body: row.body! }

  const duplicateMetaKey = db.prepare(`SELECT 1 FROM library_scan_audit_manifests m,
    json_each(m.meta_json) AS field WHERE m.run_id = ?
    GROUP BY field.key HAVING COUNT(*) > 1 LIMIT 1`).get(source.runId)
  if (duplicateMetaKey) throw new Error('Entries audit metadata contains duplicate root keys')
  const sectionNames = ['files', 'removedResources', 'promotedResources', 'deletedVideos', 'pendingGroups'] as const
  let meta: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(row.body!)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    meta = parsed as Record<string, unknown>
  } catch {
    throw new Error('Invalid entries audit metadata JSON')
  }
  if (meta.libraryId !== source.libraryId || meta.runId !== source.runId || meta.finishedAt !== row.finishedAt ||
      sectionNames.some((section) => Object.hasOwn(meta, section))) {
    throw new Error('Entries audit metadata identity mismatch or embedded sections')
  }
  const arrays: Record<(typeof sectionNames)[number], Record<string, unknown>[]> = {
    files: [], removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: []
  }
  const entries = db.prepare(`SELECT section, entry_key, entry_json FROM library_scan_audit_entries
    WHERE run_id = ? ORDER BY section, ordinal`).iterate(source.runId) as Iterable<
    { section: (typeof sectionNames)[number]; entry_key: string | null; entry_json: string }>
  for (const entry of entries) {
    let value: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(entry.entry_json)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      value = parsed as Record<string, unknown>
    } catch {
      throw new Error('Invalid entries audit entry JSON')
    }
    if (!Object.hasOwn(arrays, entry.section) ||
        (entry.section === 'files' && (typeof entry.entry_key !== 'string' || !entry.entry_key || entry.entry_key !== value.filePath))) {
      throw new Error('Invalid entries audit section or file key')
    }
    arrays[entry.section].push(value)
  }
  const audit = normalizeAudit({ ...meta, ...arrays })
  if (!audit) throw new Error('Invalid reconstructed entries audit')
  return { ...source, body: JSON.stringify(audit) }
}
