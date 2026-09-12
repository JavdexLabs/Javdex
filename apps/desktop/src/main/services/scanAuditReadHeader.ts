import type Database from 'better-sqlite3'
import type { LibraryScanSummary } from '@shared/libraryTypes'
import type { ScanAuditReadHeader } from '@shared/scanAuditReadTypes'
import { SCAN_AUDIT_HEADER_BYTES } from './scanAuditReadPolicy'
import { readScanAuditSource } from '@library/db/scanAuditSource'

/** No audit JSON or unrecognized row arrays cross this boundary. Run on the shared read worker. */
export function readScanAuditHeader(db: Database.Database, libraryId: number): ScanAuditReadHeader {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) throw new Error('媒体库 ID 无效')
  return db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM media_libraries WHERE id=?').get(libraryId)) throw new Error('媒体库不存在')
    const bytes = db.prepare('SELECT length(CAST(last_summary_json AS BLOB)) AS bytes FROM media_library_scan_state WHERE library_id=?')
      .get(libraryId) as {bytes:number|null}|undefined
    if ((bytes?.bytes??0)>SCAN_AUDIT_HEADER_BYTES) throw new Error('Audit summary exceeds byte budget')
    const row = db.prepare('SELECT last_summary_json AS value FROM media_library_scan_state WHERE library_id=?')
      .get(libraryId) as {value:string|null}|undefined
    let summary: LibraryScanSummary|null = null
    try {
      const value:unknown = row?.value ? JSON.parse(row.value) : null
      if (value && typeof value==='object' && !Array.isArray(value)) {
        const candidate=value as Record<string,unknown>
        if (candidate.libraryId===libraryId && typeof candidate.runId==='string'
          && typeof candidate.status==='string' && typeof candidate.finishedAt==='string') summary=candidate as unknown as LibraryScanSummary
      }
    } catch { /* Match the existing latest snapshot's malformed-summary null behavior. */ }
    const hasAudit = summary ? readScanAuditSource(db, { libraryId, runId: summary.runId }, 'identity') : undefined
    const unrecognizedCount = (db.prepare('SELECT COUNT(*) AS n FROM library_unrecognized_files WHERE library_id=?').get(libraryId) as {n:number}).n
    const result:ScanAuditReadHeader = {summary,snapshot:summary&&hasAudit?{libraryId,runId:summary.runId,finishedAt:summary.finishedAt}:null,unrecognizedCount}
    if (Buffer.byteLength(JSON.stringify(result))>SCAN_AUDIT_HEADER_BYTES) throw new Error('Audit summary exceeds byte budget')
    return result
  })()
}
