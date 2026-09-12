import type Database from 'better-sqlite3'
import type { LibraryScanAudit, LibraryScanNfoAudit } from '@shared/libraryTypes'
import { SCAN_AUDIT_SECTIONS, type ScanAuditSection } from '@shared/scanAuditReadTypes'
import { isFileEntry, isResourceEntry, normalizeAudit } from '../scanner/libraryScanAuditValidation'
import { visitPendingScanAuditEntriesForRun } from './pendingScanAuditRepo'

export type ScanAuditMetadata = Omit<LibraryScanAudit, ScanAuditSection>
export interface ScanAuditWriterScope { libraryId: number; runId: string }
export const SCAN_AUDIT_WRITE_MAX_ITEMS = 100
export const SCAN_AUDIT_WRITE_MAX_BYTES = 1024 * 1024
export const SCAN_AUDIT_META_MAX_BYTES = 256 * 1024

function encodeObject(value: unknown): { body: string; value: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Audit input must be a JSON object')
  const body = JSON.stringify(value)
  if (typeof body !== 'string') throw new Error('Audit input is not serializable')
  const parsed: unknown = JSON.parse(body)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Audit input must serialize to an object')
  return { body, value: parsed as Record<string, unknown> }
}

function positiveId(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function text(value: unknown): boolean { return typeof value === 'string' && value.length > 0 }

function validateEntry(section: ScanAuditSection, value: Record<string, unknown>): void {
  let valid: boolean
  switch (section) {
    case 'files': valid = isFileEntry(value); break
    case 'removedResources':
    case 'promotedResources': valid = isResourceEntry(value); break
    case 'deletedVideos':
      valid = positiveId(value.videoId) && text(value.videoCode) &&
        (value.videoTitle === null || typeof value.videoTitle === 'string') && value.reason === 'resource_less'
      break
    case 'pendingGroups':
      valid = positiveId(value.groupId) && text(value.normalizedCode) &&
        Number.isSafeInteger(value.resourceCount) && Number(value.resourceCount) >= 0
      break
    default: throw new Error('Unknown audit section')
  }
  if (!valid) throw new Error(`Invalid audit entry in ${section}`)
}

/**
 * Synchronous, caller-owned connection. Nested transactions are savepoints, so
 * callers may commit business changes and audit writes in one outer transaction.
 * This module does not publish, recover, activate scanning, or own the connection.
 * Budgets apply to each operation, not cumulative retention. Initial finishedAt
 * may be a nonempty placeholder; seal supplies final metadata before publication.
 * Encoding precedes byte checks: these limits do not bound caller input memory
 * or the temporary allocation made by JSON.stringify.
 */
export function createScanAuditWriter(db: Database.Database, scope: ScanAuditWriterScope) {
  const { libraryId, runId } = scope
  if (!positiveId(libraryId) || typeof runId !== 'string' || !runId || runId.length > 256) throw new Error('Invalid audit writer scope')

  function assertRunning(): void {
    const run = db.prepare('SELECT library_id, status, audit_json IS NULL AS json_free FROM library_scan_runs WHERE id=?')
      .get(runId) as { library_id: number; status: string; json_free: number } | undefined
    if (!run || run.library_id !== libraryId) throw new Error('Audit run does not belong to library')
    if (run.status !== 'running' || run.json_free !== 1) throw new Error('Audit requires a running JSON-free run')
  }

  function assertCollecting(): void {
    assertRunning()
    const row = db.prepare('SELECT state FROM library_scan_audit_manifests WHERE run_id=?').get(runId) as
      { state: string } | undefined
    if (row?.state !== 'collecting') throw new Error('Audit is not collecting')
  }

  function metadata(meta: ScanAuditMetadata): string {
    const { body, value } = encodeObject(meta)
    if (Buffer.byteLength(body) > SCAN_AUDIT_META_MAX_BYTES) throw new Error('Audit metadata exceeds 256 KiB')
    if (value.libraryId !== libraryId || value.runId !== runId ||
        typeof value.finishedAt !== 'string' || !value.finishedAt || value.finishedAt.length > 100 ||
        SCAN_AUDIT_SECTIONS.some((section) => Object.hasOwn(value, section)) ||
        !normalizeAudit({ ...value, files: [], removedResources: [], promotedResources: [], deletedVideos: [], pendingGroups: [] })) {
      throw new Error('Invalid audit metadata or scope')
    }
    return body
  }

  function assertPageFits(section: ScanAuditSection, ordinal: number, body: string): void {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error('Audit ordinal exceeds safe integer range')
    // Match the raw ScanAuditIndexPage wrapper. Reserve 100 UTF-16 code units at
    // the worst JSON escape size (6 bytes each), plus safe maximum count/offset
    // and the largest legal limit. Future final timestamps cannot grow the bound.
    const wrapper = JSON.stringify({
      snapshot: { libraryId, runId, finishedAt: '\u0000'.repeat(100) }, section,
      items: [], total: Number.MAX_SAFE_INTEGER, limit: 100, offset: Number.MAX_SAFE_INTEGER
    })
    const itemHead = JSON.stringify({ ordinal })
    const item = `${itemHead.slice(0, -1)},"entry":${body}}`
    if (Buffer.byteLength(wrapper) + Buffer.byteLength(item) > SCAN_AUDIT_WRITE_MAX_BYTES) {
      throw new Error('Single audit entry page exceeds 1 MiB')
    }
  }

  function start(meta: ScanAuditMetadata): void {
    const body = metadata(meta)
    db.transaction(() => {
      assertRunning()
      db.prepare('INSERT INTO library_scan_audit_manifests(run_id,meta_json) VALUES(?,?)').run(runId, body)
    })()
  }

  function writeBatch<S extends ScanAuditSection>(section: S, entries: readonly LibraryScanAudit[S][number][]): void {
    if (!SCAN_AUDIT_SECTIONS.includes(section)) throw new Error('Unknown audit section')
    if (!Array.isArray(entries) || entries.length > SCAN_AUDIT_WRITE_MAX_ITEMS) throw new Error('Audit batch exceeds 100 items')
    let bytes = 2
    const rows = entries.map((entry, index) => {
      const row = encodeObject(entry)
      validateEntry(section, row.value)
      bytes += Buffer.byteLength(row.body) + (index === 0 ? 0 : 1)
      if (bytes > SCAN_AUDIT_WRITE_MAX_BYTES) throw new Error('Audit batch exceeds 1 MiB')
      return { body: row.body, key: section === 'files' ? row.value.filePath as string : null }
    })
    db.transaction(() => {
      assertCollecting()
      const existing = db.prepare('SELECT ordinal FROM library_scan_audit_entries WHERE run_id=? AND section=? AND entry_key=?')
      const next = db.prepare('SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM library_scan_audit_entries WHERE run_id=? AND section=?')
      const write = db.prepare(`INSERT INTO library_scan_audit_entries(run_id,section,ordinal,entry_key,entry_json,entry_bytes)
        VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,section,entry_key) DO UPDATE SET
        entry_json=excluded.entry_json,entry_bytes=excluded.entry_bytes`)
      for (const row of rows) {
        const previous = row.key === null ? undefined : existing.get(runId, section, row.key) as { ordinal: number } | undefined
        const { ordinal } = previous ?? next.get(runId, section) as { ordinal: number }
        assertPageFits(section, ordinal, row.body)
        write.run(runId, section, ordinal, row.key, row.body, Buffer.byteLength(row.body))
      }
    })()
  }

  /** Detached NFO only: undefined means missing file; {} means no NFO field. */
  function readFileNfo(filePath: string): { nfo?: LibraryScanNfoAudit } | undefined {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid audit file path')
    return db.transaction(() => {
      assertCollecting()
      const size = db.prepare("SELECT entry_bytes FROM library_scan_audit_entries WHERE run_id=? AND section='files' AND entry_key=?")
        .get(runId, filePath) as { entry_bytes: number } | undefined
      if (!size) return undefined
      if (size.entry_bytes > SCAN_AUDIT_WRITE_MAX_BYTES) throw new Error('Stored audit entry exceeds 1 MiB before hydration')
      const row = db.prepare(`SELECT json_type(entry_json, '$.nfo') AS nfo_type,
        CASE WHEN json_type(entry_json, '$.nfo') = 'object'
          THEN json_extract(entry_json, '$.nfo') END AS nfo_json
        FROM library_scan_audit_entries WHERE run_id=? AND section='files' AND entry_key=?`)
        .get(runId, filePath) as { nfo_type: string | null; nfo_json: string | null }
      if (row.nfo_type === null || row.nfo_type === 'null') return {}
      if (row.nfo_type !== 'object' || row.nfo_json === null) throw new Error('Invalid stored audit NFO')
      const nfo: unknown = JSON.parse(row.nfo_json)
      const entry = { rootId: 1, filePath, sourceKind: 'local', outcome: 'unrecognized', nfo }
      if (!isFileEntry(entry)) throw new Error('Invalid stored audit NFO')
      return { nfo: entry.nfo }
    })()
  }

  /** Replaces the whole NFO value; caller supplies final merged warnings/fields. */
  function patchNfo(filePath: string, nfo: LibraryScanNfoAudit): boolean {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid audit file path')
    const patch = encodeObject(nfo)
    if (Buffer.byteLength(patch.body) > SCAN_AUDIT_WRITE_MAX_BYTES) throw new Error('NFO patch exceeds 1 MiB')
    // Reuse the shared NFO validator through its containing file entry, even if
    // the target is absent; malformed patches must not silently become no-ops.
    validateEntry('files', { rootId: 1, filePath, sourceKind: 'local', outcome: 'unrecognized', nfo: patch.value })
    return db.transaction(() => {
      assertCollecting()
      const size = db.prepare("SELECT entry_bytes FROM library_scan_audit_entries WHERE run_id=? AND section='files' AND entry_key=?")
        .get(runId, filePath) as { entry_bytes: number } | undefined
      if (!size) return false
      if (size.entry_bytes > SCAN_AUDIT_WRITE_MAX_BYTES) throw new Error('Stored audit entry exceeds 1 MiB before hydration')
      const row = db.prepare("SELECT ordinal,entry_json FROM library_scan_audit_entries WHERE run_id=? AND section='files' AND entry_key=?")
        .get(runId, filePath) as { ordinal: number; entry_json: string } | undefined
      if (!row) return false
      const updated = encodeObject({ ...JSON.parse(row.entry_json), nfo: patch.value })
      validateEntry('files', updated.value)
      if (updated.value.filePath !== filePath) throw new Error('Audit file key mismatch')
      assertPageFits('files', row.ordinal, updated.body)
      db.prepare("UPDATE library_scan_audit_entries SET entry_json=?,entry_bytes=? WHERE run_id=? AND section='files' AND entry_key=?")
        .run(updated.body, Buffer.byteLength(updated.body), runId, filePath)
      return true
    })()
  }

  /** Rebuild the derived section atomically from final file outcomes and current pending rows. */
  function refreshPendingGroups(): void {
    db.transaction(() => {
      assertCollecting()
      db.prepare("DELETE FROM library_scan_audit_entries WHERE run_id=? AND section='pendingGroups'").run(runId)
      let batch: LibraryScanAudit['pendingGroups'] = []
      let batchBytes = 2
      const flush = (): void => {
        if (batch.length > 0) writeBatch('pendingGroups', batch)
        batch = []
        batchBytes = 2
      }
      visitPendingScanAuditEntriesForRun(db, { libraryId, runId }, (entry) => {
        const entryBytes = Buffer.byteLength(JSON.stringify(entry))
        if (batch.length > 0 && (batch.length === SCAN_AUDIT_WRITE_MAX_ITEMS ||
            batchBytes + 1 + entryBytes > SCAN_AUDIT_WRITE_MAX_BYTES)) flush()
        batchBytes += (batch.length > 0 ? 1 : 0) + entryBytes
        batch.push(entry)
        // Oversized singletons fail through the normal writer validation.
        if (batchBytes > SCAN_AUDIT_WRITE_MAX_BYTES) flush()
      })
      flush()
    })()
  }

  function seal(meta: ScanAuditMetadata): void {
    const body = metadata(meta)
    db.transaction(() => {
      assertCollecting()
      const previous = db.prepare('SELECT meta_json = ? AS same FROM library_scan_audit_manifests WHERE run_id=?').get(body, runId) as { same: number }
      if (previous.same !== 1) {
        db.prepare('UPDATE library_scan_audit_manifests SET meta_json=? WHERE run_id=?').run(body, runId)
      }
      db.prepare("UPDATE library_scan_audit_manifests SET state='sealed',sealed_at=CURRENT_TIMESTAMP WHERE run_id=?").run(runId)
    })()
  }

  return { start, writeBatch, readFileNfo, patchNfo, refreshPendingGroups, seal }
}
