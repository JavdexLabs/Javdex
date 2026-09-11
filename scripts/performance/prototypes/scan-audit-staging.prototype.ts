import type Database from 'better-sqlite3'

/**
 * UNSHIPPED PROTOTYPE: scratch databases only; no production runtime imports.
 * Caller supplies a native better-sqlite3 scratch connection initialized with
 * the official schema (library_scan_runs); this module neither owns nor closes db.
 * Only prototype_audit_manifest and prototype_audit_entries are created.
 * JSON object checks are NOT a complete production-validated audit schema.
 * Crashes after a business commit but before its audit write are NOT solved here.
 * publish's callback must be synchronous SQL on this same connection; external
 * side effects and asynchronous callbacks cannot participate in its rollback.
 */
export const PROTOTYPE_AUDIT_MAX_BATCH_ROWS = 100
export const PROTOTYPE_AUDIT_MAX_BATCH_BYTES = 1024 * 1024
export const PROTOTYPE_AUDIT_MAX_PAGE_BYTES = 1024 * 1024
export const PROTOTYPE_AUDIT_MAX_META_BYTES = 256 * 1024

export type PrototypeAuditSection =
  | 'files'
  | 'removedResources'
  | 'promotedResources'
  | 'deletedVideos'
  | 'pendingGroups'

export type PrototypeAuditState = 'collecting' | 'sealed' | 'published' | 'abandoned'

export interface PrototypeAuditRow {
  section: PrototypeAuditSection
  key?: string
  entry: Record<string, unknown>
}

export interface PrototypeAuditPageItem {
  ordinal: number
  key: string | null
  entry: Record<string, unknown>
  bytes: number
}

const sections = new Set<string>([
  'files', 'removedResources', 'promotedResources', 'deletedVideos', 'pendingGroups'
])

function assertSection(section: string): asserts section is PrototypeAuditSection {
  if (!sections.has(section)) throw new Error('Unknown audit section')
}

function serializeRecord(value: Record<string, unknown>): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Audit value must be a JSON object')
  }
  const body = JSON.stringify(value)
  if (typeof body !== 'string') throw new Error('Audit value is not serializable')
  const decoded: unknown = JSON.parse(body)
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Serialized audit value must be a JSON object')
  }
  return body
}

function assertSingleItemPageFits(ordinal: number, key: string | null, bytes: number, body: string): void {
  // Match readPage's actual item and array wrapper without parsing the body again.
  const head = JSON.stringify({ ordinal, key, bytes })
  const page = `[${head.slice(0, -1)},"entry":${body}}]`
  if (Buffer.byteLength(page, 'utf8') > PROTOTYPE_AUDIT_MAX_PAGE_BYTES) {
    throw new Error('Serialized single-item audit page exceeds 1 MiB')
  }
}

export function createPrototypeAuditStore(db: Database.Database) {
  db.pragma('foreign_keys = ON')
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    throw new Error('Scratch connection must enable foreign keys before a transaction')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS prototype_audit_manifest (
      run_id TEXT PRIMARY KEY REFERENCES library_scan_runs(id),
      state TEXT NOT NULL CHECK(state IN ('collecting', 'sealed', 'published', 'abandoned')),
      meta_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prototype_audit_entries (
      run_id TEXT NOT NULL REFERENCES prototype_audit_manifest(run_id),
      section TEXT NOT NULL CHECK(section IN (
        'files', 'removedResources', 'promotedResources', 'deletedVideos', 'pendingGroups'
      )),
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      entry_key TEXT,
      body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body) = 'object'),
      bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes = length(CAST(body AS BLOB))),
      PRIMARY KEY(run_id, section, ordinal),
      UNIQUE(run_id, section, entry_key),
      CHECK(
        (section = 'files' AND entry_key IS NOT NULL AND length(entry_key) > 0)
        OR (section <> 'files' AND entry_key IS NULL)
      )
    );
  `)

  function assertRun(libraryId: number, runId: string, running = false): string {
    if (!Number.isSafeInteger(libraryId) || libraryId <= 0 || typeof runId !== 'string' || !runId) {
      throw new Error('Invalid library or run identity')
    }
    const run = db.prepare('SELECT library_id, status FROM library_scan_runs WHERE id = ?').get(runId) as
      | { library_id: number; status: string }
      | undefined
    if (!run || run.library_id !== libraryId) throw new Error('Run does not belong to library')
    if (running && run.status !== 'running') throw new Error('Run is not running')
    return run.status
  }

  function assertTerminalRun(libraryId: number, runId: string): void {
    const status = assertRun(libraryId, runId)
    if (!['completed', 'failed', 'cancelled', 'unavailable'].includes(status)) {
      throw new Error('Audit run is not terminal')
    }
  }

  function readManifest(runId: string) {
    return db.prepare('SELECT state FROM prototype_audit_manifest WHERE run_id = ?').get(runId) as
      | { state: PrototypeAuditState }
      | undefined
  }

  function assertState(libraryId: number, runId: string, state: PrototypeAuditState): void {
    assertRun(libraryId, runId, true)
    if (readManifest(runId)?.state !== state) throw new Error(`Audit is not ${state}`)
  }

  function start(libraryId: number, runId: string, meta: Record<string, unknown>): void {
    const body = serializeRecord(meta)
    if (Buffer.byteLength(body, 'utf8') > PROTOTYPE_AUDIT_MAX_META_BYTES) {
      throw new Error('Audit metadata exceeds 256 KiB')
    }
    db.transaction(() => {
      assertRun(libraryId, runId, true)
      db.prepare("INSERT INTO prototype_audit_manifest(run_id, state, meta_json) VALUES (?, 'collecting', ?)")
        .run(runId, body)
    })()
  }

  /** Budget is the UTF-8 JSON of the entire normalized rows array, not just bodies. */
  function writeBatch(libraryId: number, runId: string, rows: readonly PrototypeAuditRow[]): void {
    if (!Array.isArray(rows) || rows.length > PROTOTYPE_AUDIT_MAX_BATCH_ROWS) {
      throw new Error('Audit batch exceeds 100 rows')
    }
    let batchBytes = 2 // JSON array brackets
    const encoded = rows.map((row, index) => {
      assertSection(row.section)
      if (row.section === 'files' ? typeof row.key !== 'string' || !row.key : row.key !== undefined) {
        throw new Error('Files require a nonempty entry key; other sections cannot have a key')
      }
      const body = serializeRecord(row.entry)
      const prefix = JSON.stringify({ section: row.section, ...(row.key === undefined ? {} : { key: row.key }) })
      const encodedRow = `${prefix.slice(0, -1)},"entry":${body}}`
      batchBytes += Buffer.byteLength(encodedRow, 'utf8') + (index === 0 ? 0 : 1)
      if (batchBytes > PROTOTYPE_AUDIT_MAX_BATCH_BYTES) throw new Error('Audit batch exceeds 1 MiB')
      return { section: row.section, key: row.key ?? null, body, bytes: Buffer.byteLength(body, 'utf8') }
    })
    db.transaction(() => {
      assertState(libraryId, runId, 'collecting')
      const nextOrdinal = db.prepare(
        'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM prototype_audit_entries WHERE run_id = ? AND section = ?'
      )
      const existingOrdinal = db.prepare(
        'SELECT ordinal FROM prototype_audit_entries WHERE run_id = ? AND section = ? AND entry_key = ?'
      )
      const insert = db.prepare(`
        INSERT INTO prototype_audit_entries(run_id, section, ordinal, entry_key, body, bytes)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, section, entry_key) DO UPDATE SET body = excluded.body, bytes = excluded.bytes
      `)
      for (const row of encoded) {
        const existing = row.key === null ? undefined :
          existingOrdinal.get(runId, row.section, row.key) as { ordinal: number } | undefined
        const { ordinal } = existing ?? nextOrdinal.get(runId, row.section) as { ordinal: number }
        assertSingleItemPageFits(ordinal, row.key, row.bytes, row.body)
        insert.run(runId, row.section, ordinal, row.key, row.body, row.bytes)
      }
    })()
  }

  function patchNfo(libraryId: number, runId: string, key: string, nfo: Record<string, unknown>): boolean {
    if (typeof key !== 'string' || !key) throw new Error('Missing file entry key')
    const nfoBody = serializeRecord(nfo)
    if (Buffer.byteLength(nfoBody, 'utf8') > PROTOTYPE_AUDIT_MAX_BATCH_BYTES) {
      throw new Error('NFO patch exceeds 1 MiB')
    }
    return db.transaction(() => {
      assertState(libraryId, runId, 'collecting')
      const row = db.prepare("SELECT ordinal, body FROM prototype_audit_entries WHERE run_id = ? AND section = 'files' AND entry_key = ?")
        .get(runId, key) as { ordinal: number; body: string } | undefined
      if (!row) return false
      const body = JSON.stringify({ ...JSON.parse(row.body), nfo: JSON.parse(nfoBody) })
      const bytes = Buffer.byteLength(body, 'utf8')
      if (bytes > PROTOTYPE_AUDIT_MAX_BATCH_BYTES) throw new Error('Patched audit entry exceeds 1 MiB')
      assertSingleItemPageFits(row.ordinal, key, bytes, body)
      db.prepare("UPDATE prototype_audit_entries SET body = ?, bytes = ? WHERE run_id = ? AND section = 'files' AND entry_key = ?")
        .run(body, bytes, runId, key)
      return true
    })()
  }

  function seal(libraryId: number, runId: string): void {
    db.transaction(() => {
      assertState(libraryId, runId, 'collecting')
      db.prepare("UPDATE prototype_audit_manifest SET state = 'sealed' WHERE run_id = ?").run(runId)
    })()
  }

  function publish(libraryId: number, runId: string, commit: () => void): void {
    db.transaction(() => {
      assertState(libraryId, runId, 'sealed')
      db.prepare("UPDATE prototype_audit_manifest SET state = 'published' WHERE run_id = ?").run(runId)
      const result: unknown = commit()
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('Publish callback must be synchronous')
      }
      assertTerminalRun(libraryId, runId)
    })()
  }

  /** Zero-based offsets; returns only the requested rows, never a full audit DTO. */
  function readPage(
    libraryId: number, runId: string, section: PrototypeAuditSection, offset: number, limit: number
  ): PrototypeAuditPageItem[] {
    assertSection(section)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Invalid audit page bounds')
    }
    return db.transaction(() => {
      assertTerminalRun(libraryId, runId)
      if (readManifest(runId)?.state !== 'published') throw new Error('Audit is not published')
      const sizes = db.prepare(`
        SELECT ordinal, bytes, length(CAST(json_quote(entry_key) AS BLOB)) AS key_bytes
        FROM prototype_audit_entries
        WHERE run_id = ? AND section = ? ORDER BY ordinal LIMIT ? OFFSET ?
      `).all(runId, section, limit, offset) as { ordinal: number; bytes: number; key_bytes: number }[]
      if (sizes.reduce((total, row) => total + row.bytes + row.key_bytes, 0) > PROTOTYPE_AUDIT_MAX_PAGE_BYTES) {
        throw new Error('Audit page bodies and encoded keys exceed 1 MiB')
      }
      const rows = db.prepare(`
        SELECT ordinal, entry_key AS key, body, bytes FROM prototype_audit_entries
        WHERE run_id = ? AND section = ? ORDER BY ordinal LIMIT ? OFFSET ?
      `).all(runId, section, limit, offset) as { ordinal: number; key: string | null; body: string; bytes: number }[]
      const items = rows.map(({ body, ...row }) => ({ ...row, entry: JSON.parse(body) as Record<string, unknown> }))
      if (Buffer.byteLength(JSON.stringify(items), 'utf8') > PROTOTYPE_AUDIT_MAX_PAGE_BYTES) {
        throw new Error('Serialized audit page exceeds 1 MiB')
      }
      return items
    })()
  }

  function recover(libraryId: number, runId: string): boolean {
    return db.transaction(() => {
      assertRun(libraryId, runId)
      return db.prepare("UPDATE prototype_audit_manifest SET state = 'abandoned' WHERE run_id = ? AND state IN ('collecting', 'sealed')")
        .run(runId).changes === 1
    })()
  }

  /** Bounded output: state and at most five section counts, with no entry bodies. */
  function inspect(libraryId: number, runId: string) {
    return db.transaction(() => {
      assertRun(libraryId, runId)
      const manifest = readManifest(runId)
      if (!manifest) return null
      const counts = db.prepare(`
        SELECT section, COUNT(*) AS count, SUM(bytes) AS bytes FROM prototype_audit_entries
        WHERE run_id = ? GROUP BY section ORDER BY section
      `).all(runId) as { section: PrototypeAuditSection; count: number; bytes: number }[]
      return {
        state: manifest.state,
        count: counts.reduce((total, row) => total + row.count, 0),
        bytes: counts.reduce((total, row) => total + row.bytes, 0),
        sections: counts
      }
    })()
  }

  return { start, writeBatch, patchNfo, seal, publish, readPage, recover, inspect }
}
