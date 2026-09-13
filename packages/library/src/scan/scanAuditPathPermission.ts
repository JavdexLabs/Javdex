import type Database from 'better-sqlite3'
import path from 'node:path'
import { normalizeAbsoluteLocalPath } from '@library/localPathIdentity'
import { isFileEntry, isResourceEntry, normalizeAudit } from '@library/scan/libraryScanAuditValidation'
import { SCAN_AUDIT_READ_LIMITS } from './scanAuditReadPolicy'
import { readScanAuditSource } from '@library/db/scanAuditSource'

export function normalizeAuditPathRequest(libraryId: number, filePath: string) {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0 || typeof filePath !== 'string' || filePath.length > 32768) throw new Error('Invalid audit path request')
  normalizeAbsoluteLocalPath(filePath)
  return {libraryId,filePath}
}

/** Read on the shared readonly worker: project scalars and one validated entry at a time. */
export function createScanAuditPathPermissionReader(db: Database.Database) {
  db.function('scan_audit_path_entry_check', {deterministic:true}, (section:unknown, type:unknown, raw:unknown, target:unknown) => {
    if (type !== 'object' || typeof raw !== 'string' || typeof target !== 'string') return 0
    const value:unknown = JSON.parse(raw)
    if (section === 'files') {
      if (!isFileEntry(value)) return 0
      return path.resolve(value.filePath).toLowerCase() === target ? 2 : 1
    }
    if (!isResourceEntry(value)) return 0
    return value.sourcePath != null && path.resolve(value.sourcePath).toLowerCase() === target ? 2 : 1
  })
  return (libraryId: number, filePath: string): boolean => {
    normalizeAuditPathRequest(libraryId,filePath)
    const normalized = normalizeAbsoluteLocalPath(filePath).normalizedPath
    // Match the historical audit comparison, which folds case on every platform.
    const target = path.resolve(filePath).toLowerCase()
    return db.transaction(() => {
      if (db.prepare('SELECT 1 FROM library_unrecognized_files WHERE library_id=? AND normalized_path=? LIMIT 1').get(libraryId,normalized)) return true
      const latest = readScanAuditSource(db, { libraryId, latest: true }, 'bytes')
      if (!latest) return false
      if (latest.bytes > SCAN_AUDIT_READ_LIMITS.sourceBytes) throw new Error('Audit source exceeds byte budget')
      const entries = latest.format === 'entries'
      const published = entries ? db.prepare(`SELECT r.finished_at AS finishedAt,
        json_valid(m.meta_json) AS valid, CASE WHEN json_valid(m.meta_json) THEN json_type(m.meta_json) END AS type
        FROM library_scan_runs r JOIN library_scan_audit_manifests m ON m.run_id=r.id
        WHERE r.library_id=? AND r.id=? AND m.state='published' AND m.format_version=1
          AND r.audit_json IS NULL AND r.status IN ('completed','failed','cancelled','unavailable')`)
        .get(libraryId,latest.runId) as {finishedAt:string|null;valid:number;type:string}|undefined : undefined
      if (entries) {
        if (!published?.valid || published.type!=='object' || !published.finishedAt) return false
        if (db.prepare(`SELECT 1 FROM library_scan_audit_manifests m,json_each(m.meta_json) e
          WHERE m.run_id=? GROUP BY e.key HAVING COUNT(*)>1 LIMIT 1`).get(latest.runId)) return false
      } else if (!(db.prepare('SELECT json_valid(audit_json) AS valid FROM library_scan_runs WHERE library_id=? AND id=?').get(libraryId,latest.runId) as {valid:number}).valid) return false
      const fields=['schemaVersion','libraryId','runId','configRevision','trigger','status','startedAt','finishedAt']
      const collections=['files','removedResources','promotedResources','deletedVideos','pendingGroups']
      const meta:Record<string,unknown>={},seen=new Set<string>()
      const properties=db.prepare(`SELECT e.key,e.type,CASE WHEN e.type IN ('text','integer','real','true','false','null') THEN e.value ELSE NULL END AS scalar
        FROM library_scan_runs r ${entries ? 'JOIN library_scan_audit_manifests m ON m.run_id=r.id' : ''},
          json_each(${entries ? 'm.meta_json' : 'r.audit_json'}) e WHERE r.library_id=? AND r.id=?
        AND e.key IN (${[...fields,...collections].map(name=>`'${name}'`).join(',')})`).iterate(libraryId,latest.runId)
      for (const property of properties) {
        const row=property as {key:string;type:string;scalar:unknown}
        // Persisted JSON.stringify audits have unique fields. Do not authorize an ambiguous duplicate-key document.
        if (seen.has(row.key)) return false
        seen.add(row.key)
        if (collections.includes(row.key)) { if(entries || row.type!=='array') return false;meta[row.key]=[] }
        else meta[row.key]=row.type==='true'?true:row.type==='false'?false:row.scalar
      }
      if (entries) for (const collection of collections) meta[collection]=[]
      const valid=normalizeAudit(meta)
      if (!valid || valid.libraryId!==libraryId) return false
      if (entries && (valid.runId!==latest.runId || valid.finishedAt!==published?.finishedAt)) return false
      let found=false
      for (const section of ['files','removedResources','promotedResources']) {
        const rows=entries ? db.prepare(`SELECT CASE
          WHEN section='files' AND entry_key IS NOT json_extract(entry_json,'$.filePath') THEN 0
          ELSE scan_audit_path_entry_check(?,json_type(entry_json),entry_json,?) END AS code
          FROM library_scan_audit_entries WHERE run_id=? AND section=? ORDER BY ordinal`)
          .iterate(section,target,latest.runId,section)
          : db.prepare(`SELECT scan_audit_path_entry_check(?,e.type,e.value,?) AS code
          FROM library_scan_runs r,json_each(r.audit_json,?) e WHERE r.library_id=? AND r.id=?`).iterate(section,target,`$.${section}`,libraryId,latest.runId)
        for (const result of rows) {
          const code=(result as {code:number}).code
          if (code===0) return false
          if (code===2) found=true
        }
      }
      return found
    })()
  }
}
