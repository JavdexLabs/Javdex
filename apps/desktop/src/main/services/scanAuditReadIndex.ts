import { readScanAuditHeader } from './scanAuditReadHeader'
import { prepareScanAuditViews } from './scanAuditViewIndex'
import type { ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import { openReadOnlyDatabaseAtPath } from '../db/database'
import { readScanAuditSource } from '../db/scanAuditSource'
import { normalizeAudit } from '../scanner/libraryScanAuditValidation'

import { SCAN_AUDIT_SECTIONS as sections, SCAN_AUDIT_OUTCOMES as outcomes } from '@shared/scanAuditReadTypes'
import type { ScanAuditSection, ScanAuditSnapshotIdentity, ScanAuditIndexLimits, ScanAuditIndexQuery, ScanAuditIndexPage } from '@shared/scanAuditReadTypes'
export type { ScanAuditSection, ScanAuditSnapshotIdentity, ScanAuditIndexLimits, ScanAuditIndexQuery, ScanAuditIndexPage } from '@shared/scanAuditReadTypes'

interface CountGroup { section: ScanAuditSection; outcome: string | null; attention: number; n: number }

/** Connection-owned derived data only. Synchronous: callers must dispatch construction/read to a worker. */
export function createScanAuditReadIndex(databasePath: string, identity: ScanAuditSnapshotIdentity, limits: ScanAuditIndexLimits, options: { views?: boolean } = {}) {
  if (!Number.isSafeInteger(identity.libraryId) || identity.libraryId <= 0
    || typeof identity.runId !== 'string' || !identity.runId || identity.runId.length > 256
    || typeof identity.finishedAt !== 'string' || !identity.finishedAt || identity.finishedAt.length > 100) {
    throw new Error('Invalid audit snapshot identity')
  }
  for (const value of [limits.sourceBytes, limits.indexBytes, limits.pageBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid audit index budget')
  }
  const snapshot = { libraryId: identity.libraryId, runId: identity.runId, finishedAt: identity.finishedAt }, budget = { ...limits }
  const db = openReadOnlyDatabaseAtPath(databasePath)
  let sourceBytes = 0, indexBytes = 0, auditAvailable = true
  let groups: CountGroup[] = []
  let readViews: ReturnType<typeof prepareScanAuditViews> | undefined
  try {
    // Native SQLITE_OPEN_READONLY continues to protect main while this private connection builds TEMP.
    db.pragma('query_only = OFF')
    db.pragma('temp_store = FILE')
    db.pragma('temp.cache_size = -8192')
    const pageSize = Number(db.pragma('temp.page_size', { simple: true }))
    const maxPages = Math.floor(budget.indexBytes / pageSize)
    if (maxPages < 1) throw new Error('Audit index exceeds space budget')
    const acceptedPages = Number(db.pragma(`temp.max_page_count = ${maxPages}`, { simple: true }))
    if (acceptedPages > maxPages) throw new Error('Audit index exceeds space budget')
    db.transaction(() => {
      // Reject excessive input before asking SQLite to parse the JSON document.
      const size = readScanAuditSource(db, { libraryId: snapshot.libraryId, runId: snapshot.runId }, 'bytes')
      auditAvailable = size?.bytes != null
      if (!auditAvailable) {
        if (!options.views) throw new Error('Audit snapshot unavailable')
        // Missing audit bodies are legitimate after retention/import, but only
        // the current matching summary may authorize an unrecognized-only view.
        const header = readScanAuditHeader(db, snapshot.libraryId)
        if (!header.summary || header.summary.runId !== snapshot.runId
          || header.summary.finishedAt !== snapshot.finishedAt) throw new Error('Audit summary changed; refresh scan history')
      }
      sourceBytes = size?.bytes ?? 0
      if (sourceBytes > budget.sourceBytes) throw new Error('Audit source exceeds byte budget')
      if (size?.format === 'entries') {
        if (db.prepare(`SELECT 1 FROM library_scan_audit_manifests m,json_each(m.meta_json) e
          WHERE m.run_id=? GROUP BY e.key HAVING COUNT(*)>1 LIMIT 1`).get(snapshot.runId)) {
          throw new Error('Audit snapshot does not match requested identity or structure')
        }
        const fields = ['schemaVersion', 'libraryId', 'runId', 'configRevision', 'trigger', 'status', 'startedAt', 'finishedAt']
        const meta: Record<string, unknown> = {}, seen = new Set<string>()
        const rows = db.prepare(`SELECT e.key,e.type,
          CASE WHEN e.type IN ('text','integer','real','true','false','null') THEN e.value ELSE NULL END AS scalar
          FROM library_scan_audit_manifests m,json_each(m.meta_json) e WHERE m.run_id=?
          AND e.key IN (${[...fields,...sections].map(field => `'${field}'`).join(',')})`).iterate(snapshot.runId)
        for (const value of rows) {
          const row = value as { key: string; type: string; scalar: unknown }
          if (seen.has(row.key) || (sections as readonly string[]).includes(row.key)) {
            throw new Error('Audit snapshot does not match requested identity or structure')
          }
          seen.add(row.key)
          meta[row.key] = row.type === 'true' ? true : row.type === 'false' ? false : row.scalar
        }
        for (const section of sections) meta[section] = []
        const valid = normalizeAudit(meta)
        const run = db.prepare('SELECT finished_at FROM library_scan_runs WHERE id=? AND library_id=?')
          .get(snapshot.runId,snapshot.libraryId) as { finished_at: string }
        if (!valid || valid.libraryId !== snapshot.libraryId || valid.runId !== snapshot.runId
          || valid.finishedAt !== snapshot.finishedAt || run.finished_at !== snapshot.finishedAt) {
          throw new Error('Audit snapshot does not match requested identity or structure')
        }
      } else if (auditAvailable) {
      const valid = db.prepare('SELECT json_valid(audit_json) AS valid FROM library_scan_runs WHERE library_id = ? AND id = ?')
        .get(snapshot.libraryId, snapshot.runId) as { valid: number }
      if (!valid.valid) throw new Error('Invalid audit JSON')
      const meta = db.prepare(`SELECT json_extract(audit_json,'$.schemaVersion') AS version,
        json_extract(audit_json,'$.libraryId') AS libraryId, json_extract(audit_json,'$.runId') AS runId,
        json_extract(audit_json,'$.finishedAt') AS finishedAt,
        ${sections.map(section => `json_type(audit_json,'$.${section}') AS ${section}`).join(',')}
        FROM library_scan_runs WHERE library_id = ? AND id = ?`).get(snapshot.libraryId, snapshot.runId) as Record<string, unknown>
      if ((meta.version !== 1 && meta.version !== 2)
        || meta.libraryId !== snapshot.libraryId || meta.runId !== snapshot.runId || meta.finishedAt !== snapshot.finishedAt
        || sections.some(section => meta[section] !== 'array')) throw new Error('Audit snapshot does not match requested identity or structure')
      }
      db.exec(`CREATE TEMP TABLE scan_audit_entries(
        section TEXT NOT NULL, ordinal INTEGER NOT NULL,
        entry TEXT NOT NULL CHECK(json_type(entry) = 'object'),
        entry_bytes INTEGER NOT NULL CHECK(entry_bytes >= 0),
        outcome TEXT, attention INTEGER NOT NULL,
        PRIMARY KEY(section,ordinal),
        CHECK(section != 'files' OR (outcome IS NOT NULL AND outcome IN (${outcomes.map(value => `'${value}'`).join(',')})))) WITHOUT ROWID`)
      for (const section of auditAvailable ? sections : []) {
        const file = section === 'files'
        const outcome = file ? "json_extract(value,'$.outcome')" : 'NULL'
        const attention = file ? `(json_extract(value,'$.outcome') IN ('unrecognized','strm_failure','processing_failure')
          OR COALESCE(json_extract(value,'$.nfo.disposition') IN ('warning','identity-conflict','pending-candidate'),0))` : '0'
        if (size?.format === 'entries') {
          // Keep payload in SQLite: copy one persisted section into the existing
          // bounded TEMP index, without reconstructing an audit object in JS.
          db.prepare(`INSERT INTO temp.scan_audit_entries(section,ordinal,entry,entry_bytes,outcome,attention)
            SELECT ?,ordinal,CASE WHEN ? <> 'files' OR entry_key=json_extract(value,'$.filePath') THEN value ELSE NULL END,
              entry_bytes,${outcome},${attention}
            FROM (SELECT ordinal,entry_key,entry_json AS value,entry_bytes
              FROM library_scan_audit_entries WHERE run_id=? AND section=?)
            ORDER BY ordinal`).run(section, section, snapshot.runId, section)
        } else {
          db.prepare(`INSERT INTO temp.scan_audit_entries(section,ordinal,entry,entry_bytes,outcome,attention)
            SELECT ?,CAST(key AS INTEGER),CASE WHEN e.type = 'object' THEN value ELSE NULL END,length(CAST(value AS BLOB)),${outcome},${attention}
            FROM library_scan_runs r,json_each(r.audit_json,'$.${section}') AS e
            WHERE r.library_id = ? AND r.id = ?`).run(section, snapshot.libraryId, snapshot.runId)
        }
      }
      db.exec(`CREATE INDEX temp.scan_audit_ordinal ON scan_audit_entries(section,ordinal,outcome,attention,entry_bytes);
        CREATE INDEX temp.scan_audit_outcome ON scan_audit_entries(section,outcome,ordinal,attention,entry_bytes);
        CREATE INDEX temp.scan_audit_attention ON scan_audit_entries(section,attention,ordinal,outcome,entry_bytes)`)
      if (options.views) readViews = prepareScanAuditViews(db, snapshot, budget.pageBytes, auditAvailable)
      groups = db.prepare('SELECT section,outcome,attention,COUNT(*) AS n FROM temp.scan_audit_entries GROUP BY section,outcome,attention').all() as CountGroup[]
      indexBytes = Number(db.pragma('temp.page_count', { simple: true })) * pageSize
      if (indexBytes > budget.indexBytes) throw new Error('Audit index exceeds space budget')
    })()
    db.pragma('query_only = ON')
  } catch (error) {
    if (db.open) db.close()
    throw error
  }

  return {
    readViewPage(query: ScanAuditViewQuery) {
      if (!db.open) throw new Error('Audit index is closed')
      if (!readViews) throw new Error('Audit view index was not requested')
      return readViews(query)
    },
    getInfo: () => ({ snapshot: { ...snapshot }, sourceBytes, indexBytes }),
    readPage(query: ScanAuditIndexQuery): ScanAuditIndexPage {
      if (!db.open) throw new Error('Audit index is closed')
      if (!auditAvailable) throw new Error('Audit snapshot unavailable')
      const { section, outcome, attention, limit = 100, offset = 0 } = query
      if (!sections.includes(section) || (outcome !== undefined && !outcomes.includes(outcome))
        || (attention !== undefined && typeof attention !== 'boolean')
        || (section !== 'files' && (outcome !== undefined || attention !== undefined))
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid audit page query')
      const parameters: Array<string | number> = [section]
      let where = 'section = ?'
      if (outcome !== undefined) { where += ' AND outcome = ?'; parameters.push(outcome) }
      if (attention !== undefined) { where += ' AND attention = ?'; parameters.push(Number(attention)) }
      const total = groups.reduce((sum, group) => sum + (group.section === section
        && (outcome === undefined || group.outcome === outcome)
        && (attention === undefined || group.attention === Number(attention)) ? group.n : 0), 0)
      const pageParameters = [...parameters, limit, offset]
      const sizes = db.prepare(`SELECT ordinal,entry_bytes AS bytes FROM temp.scan_audit_entries
        WHERE ${where} ORDER BY ordinal LIMIT ? OFFSET ?`).all(...pageParameters) as { ordinal: number; bytes: number }[]
      if (sizes.reduce((sum, row) => sum + row.bytes, 0) > budget.pageBytes) throw new Error('Audit page exceeds byte budget')
      // The index is immutable. Hydrate only the selected ordinal span, avoiding a second deep OFFSET.
      const rows = sizes.length === 0 ? [] : db.prepare(`SELECT ordinal,entry FROM temp.scan_audit_entries
        WHERE ${where} AND ordinal >= ? AND ordinal <= ? ORDER BY ordinal`)
        .all(...parameters,sizes[0].ordinal,sizes[sizes.length - 1].ordinal) as { ordinal: number; entry: string }[]
      const result: ScanAuditIndexPage = { snapshot: { ...snapshot }, section,
        items: rows.map(row => ({ ordinal: row.ordinal, entry: JSON.parse(row.entry) as Record<string, unknown> })), total, limit, offset }
      if (Buffer.byteLength(JSON.stringify(result)) > budget.pageBytes) throw new Error('Audit page exceeds byte budget')
      return result
    },
    dispose() { if (db.open) db.close() }
  }
}
