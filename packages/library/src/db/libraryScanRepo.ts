import type Database from 'better-sqlite3'
import type {
  LibraryScanAudit,
  LibraryScanLatestSnapshot,
  LibraryScanSummary,
  LibraryScanTrigger
} from '@shared/libraryTypes'
import { getDb } from './database'
import { readScanAuditSource } from './scanAuditSource'
import { normalizeAudit } from '@library/scan/libraryScanAuditValidation'
import { SCAN_AUDIT_META_MAX_BYTES } from './scanAuditWriter'

type PersistedScanTrigger = 'manual' | 'automatic' | 'initial' | 'root'
type PersistedScanStatus = 'completed' | 'failed' | 'cancelled'

export const INTERRUPTED_LIBRARY_SCAN_ERROR = '上次扫描因应用异常退出而中断。'

export interface InterruptedLibraryScanRecoveryResult {
  recoveredRunCount: number
  recoveredStateCount: number
}

export interface LibraryUnrecognizedFileInput {
  rootId: number
  filePath: string
  normalizedPath: string
  reason?: string | null
}

function parseScopedScanJson<T extends { libraryId: number }>(
  value: string | null | undefined,
  libraryId: number,
  validate: (candidate: Record<string, unknown>) => boolean
): T | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const candidate = parsed as Record<string, unknown>
    if (candidate.libraryId !== libraryId || !validate(candidate)) return null
    return parsed as T
  } catch {
    return null
  }
}

function persistedTrigger(trigger: LibraryScanTrigger): PersistedScanTrigger {
  if (trigger === 'manual') return 'manual'
  if (trigger === 'startup') return 'initial'
  return 'automatic'
}

/**
 * Settle scan rows left active by a previous process before this process exposes any
 * scan entry point. The immediate transaction snapshots exact run ids, so only work
 * already present at the startup boundary is changed.
 */
export function recoverInterruptedLibraryScanRuns(
  database: Database.Database,
  recoveredAt = new Date().toISOString()
): InterruptedLibraryScanRecoveryResult {
  return database.transaction(() => {
    const interrupted = database
      .prepare(
        `SELECT id, library_id
           FROM library_scan_runs
          WHERE status IN ('queued', 'running')
          ORDER BY library_id, started_at, id`
      )
      .all() as Array<{ id: string; library_id: number }>
    // Include a terminal run left sealed by an interrupted publication attempt.
    // Existing published history remains immutable and is never reclassified.
    const abandon = database.prepare(`UPDATE library_scan_audit_manifests SET state='abandoned'
      WHERE state IN ('collecting','sealed') AND run_id IN (
        SELECT id FROM library_scan_runs WHERE status NOT IN ('queued','running'))`)
    if (interrupted.length === 0) {
      abandon.run()
      return { recoveredRunCount: 0, recoveredStateCount: 0 }
    }

    const updateRun = database.prepare(
      `UPDATE library_scan_runs
          SET status = 'failed', finished_at = ?, error_summary = ?
        WHERE id = ? AND library_id = ? AND status IN ('queued', 'running')`
    )
    let recoveredRunCount = 0
    for (const run of interrupted) {
      recoveredRunCount += updateRun.run(
        recoveredAt,
        INTERRUPTED_LIBRARY_SCAN_ERROR,
        run.id,
        run.library_id
      ).changes
    }

    abandon.run()

    const idsByLibrary = new Map<number, Set<string>>()
    for (const run of interrupted) {
      const ids = idsByLibrary.get(run.library_id) ?? new Set<string>()
      ids.add(run.id)
      idsByLibrary.set(run.library_id, ids)
    }
    const readState = database.prepare(
      `SELECT active_run_id, last_status
         FROM media_library_scan_state
        WHERE library_id = ?`
    )
    const updateState = database.prepare(
      `UPDATE media_library_scan_state
          SET active_run_id = NULL, last_status = 'failed', last_finished_at = ?,
              last_summary_json = NULL, last_error = ?, revision = revision + 1
        WHERE library_id = ?`
    )
    let recoveredStateCount = 0
    for (const [libraryId, runIds] of idsByLibrary) {
      const state = readState.get(libraryId) as
        | { active_run_id: string | null; last_status: string | null }
        | undefined
      if (
        !state ||
        (!runIds.has(state.active_run_id ?? '') &&
          state.last_status !== 'queued' &&
          state.last_status !== 'running')
      ) {
        continue
      }
      recoveredStateCount += updateState.run(
        recoveredAt,
        INTERRUPTED_LIBRARY_SCAN_ERROR,
        libraryId
      ).changes
    }

    return { recoveredRunCount, recoveredStateCount }
  }).immediate()
}

export function beginLibraryScanRun(input: {
  libraryId: number
  runId: string
  configRevision: number
  trigger: LibraryScanTrigger
  startedAt: string
}): void {
  const database = getDb()
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, ?, ?, ?, 'running', ?)`
      )
      .run(
        input.runId,
        input.libraryId,
        input.configRevision,
        persistedTrigger(input.trigger),
        input.startedAt
      )
    database
      .prepare('INSERT OR IGNORE INTO media_library_scan_state (library_id) VALUES (?)')
      .run(input.libraryId)
    database
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = ?, last_status = 'running', last_started_at = ?,
                last_error = NULL, revision = revision + 1
          WHERE library_id = ?`
      )
      .run(input.runId, input.startedAt, input.libraryId)
  })()
}

export function finishLibraryScanRun(input: {
  libraryId: number
  runId: string
  status: PersistedScanStatus
  summary: LibraryScanSummary
  audit: LibraryScanAudit
  replaceUnrecognizedRootIds?: readonly number[]
  unrecognizedFiles?: readonly LibraryUnrecognizedFileInput[]
}): void {
  completeLibraryScanRun(input, input.audit)
}

export type FinishLibraryScanEntriesInput = Omit<Parameters<typeof finishLibraryScanRun>[0], 'audit' | 'unrecognizedFiles'> & {
  /** Fresh iterable per publication attempt. Never retry with an exhausted/closed generator:
   * an empty successful enumeration would replace the selected roots with no rows.
   * Failed/cancelled runs and empty replacement roots do not acquire this iterator. */
  unrecognizedFiles?: Iterable<LibraryUnrecognizedFileInput>
}

/** The sealed audit, scan result and synchronous iterable replacement commit together. */
export function finishLibraryScanEntriesRun(input: FinishLibraryScanEntriesInput): void {
  completeLibraryScanRun(input)
}

function completeLibraryScanRun(
  input: FinishLibraryScanEntriesInput,
  audit?: LibraryScanAudit
): void {
  const database = getDb()
  database.transaction(() => {
    if (!audit) validateSealedAuditForPublication(database, input)
    const summaryJson = JSON.stringify(input.summary)
    const auditJson = audit ? JSON.stringify(audit) : null
    const errorSummary = input.summary.errorSummary
    const updated = database
      .prepare(
        `UPDATE library_scan_runs
            SET status = ?, finished_at = ?, summary_json = ?, audit_json = ?, error_summary = ?
          WHERE id = ? AND library_id = ? AND status = 'running'`
      )
      .run(
        input.status,
        input.summary.finishedAt,
        summaryJson,
        auditJson,
        errorSummary,
        input.runId,
        input.libraryId
      )
    if (updated.changes !== 1) throw new Error('扫描运行不存在或已经结束')

    const successful = input.status === 'completed'
    database
      .prepare(
        `UPDATE media_library_scan_state
            SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
                last_status = ?, last_finished_at = ?,
                last_successful_at = CASE WHEN ? THEN ? ELSE last_successful_at END,
                last_summary_json = ?, last_error = ?, revision = revision + 1
          WHERE library_id = ?`
      )
      .run(
        input.runId,
        input.status,
        input.summary.finishedAt,
        successful ? 1 : 0,
        input.summary.finishedAt,
        summaryJson,
        errorSummary,
        input.libraryId
      )

    if (successful && input.replaceUnrecognizedRootIds?.length) {
      const rootIds = new Set(input.replaceUnrecognizedRootIds)
      database
        .prepare(
          `DELETE FROM library_unrecognized_files
            WHERE library_id = ? AND root_id IN (SELECT value FROM json_each(?))`
        )
        .run(input.libraryId, JSON.stringify([...rootIds]))
      const insert = database.prepare(
        `INSERT INTO library_unrecognized_files (
           library_id, root_id, file_path, normalized_path, reason, scan_run_id, last_seen_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      for (const file of input.unrecognizedFiles ?? []) {
        if (!rootIds.has(file.rootId)) continue
        insert.run(
          input.libraryId,
          file.rootId,
          file.filePath,
          file.normalizedPath,
          file.reason ?? 'unrecognized_code',
          input.runId,
          input.summary.finishedAt
        )
      }
    }
    if (!audit) {
      const published = database.prepare(`UPDATE library_scan_audit_manifests
        SET state='published',published_at=? WHERE run_id=? AND state='sealed'`)
        .run(input.summary.finishedAt, input.runId)
      if (published.changes !== 1) throw new Error('扫描审计未封存或已发布')
    }
  })()
}

function validateSealedAuditForPublication(
  database: Database.Database,
  input: FinishLibraryScanEntriesInput
): void {
  if (!Number.isSafeInteger(input.libraryId) || input.libraryId <= 0
    || typeof input.runId !== 'string' || !input.runId || input.runId.length > 256
    || typeof input.summary.finishedAt !== 'string' || !input.summary.finishedAt || input.summary.finishedAt.length > 100) {
    throw new Error('扫描审计身份无效')
  }
  const size = database.prepare(`SELECT length(CAST(m.meta_json AS BLOB)) AS bytes
    FROM library_scan_audit_manifests m JOIN library_scan_runs r ON r.id=m.run_id
    WHERE r.id=? AND r.library_id=? AND r.status='running' AND m.state='sealed'`)
    .get(input.runId,input.libraryId) as { bytes: number } | undefined
  if (!size || size.bytes > SCAN_AUDIT_META_MAX_BYTES) throw new Error('扫描审计未封存或元数据超限')
  const row = database.prepare(`SELECT m.meta_json,r.config_revision,r.trigger,r.started_at FROM library_scan_audit_manifests m
    JOIN library_scan_runs r ON r.id=m.run_id
    WHERE r.id=? AND r.library_id=? AND r.status='running' AND m.state='sealed'`)
    .get(input.runId,input.libraryId) as { meta_json: string; config_revision: number; trigger: string; started_at: string } | undefined
  if (!row) throw new Error('扫描审计未封存或元数据超限')
  const meta = JSON.parse(row.meta_json) as Record<string, unknown>
  const sections = ['files','removedResources','promotedResources','deletedVideos','pendingGroups']
  const duplicate = database.prepare(`SELECT 1 FROM library_scan_audit_manifests m,json_each(m.meta_json) e
    WHERE m.run_id=? GROUP BY e.key HAVING COUNT(*)>1 LIMIT 1`).get(input.runId)
  if (duplicate || sections.some(section => Object.hasOwn(meta,section))) throw new Error('扫描审计元数据无效')
  const valid = normalizeAudit({ ...meta, ...Object.fromEntries(sections.map(section => [section,[]])) })
  const summary = input.summary
  if (!valid || summary.libraryId !== input.libraryId || summary.runId !== input.runId
    || ['libraryId','runId','configRevision','trigger','startedAt','finishedAt','status'].some(key => meta[key] !== summary[key as keyof LibraryScanSummary])
    || row.config_revision !== summary.configRevision || row.started_at !== summary.startedAt
    || row.trigger !== persistedTrigger(summary.trigger)
    || (input.status === 'completed' ? !['success','completed_with_errors'].includes(summary.status) : input.status !== summary.status)) {
    throw new Error('扫描审计与运行结果不一致')
  }
}

export function getLatestLibraryScanSnapshot(libraryId: number): LibraryScanLatestSnapshot {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) throw new Error('媒体库 ID 无效')
  const database = getDb()
  return database.transaction(() => {
    const library = database.prepare('SELECT 1 FROM media_libraries WHERE id = ?').get(libraryId)
    if (!library) throw new Error('媒体库不存在')
    const state = database
      .prepare(
        `SELECT last_summary_json
           FROM media_library_scan_state
          WHERE library_id = ?`
      )
      .get(libraryId) as { last_summary_json: string | null } | undefined
    const summary = parseScopedScanJson<LibraryScanSummary>(
      state?.last_summary_json,
      libraryId,
      (candidate) =>
        typeof candidate.runId === 'string' &&
        typeof candidate.status === 'string' &&
        typeof candidate.finishedAt === 'string'
    )
    const source = readScanAuditSource(
      database,
      summary ? { libraryId, runId: summary.runId } : { libraryId, latest: true },
      'body'
    )
    const audit = parseScopedScanJson<LibraryScanAudit>(
      source?.body,
      libraryId,
      (candidate) =>
        (candidate.schemaVersion === 1 || candidate.schemaVersion === 2) &&
        typeof candidate.runId === 'string' &&
        Array.isArray(candidate.files)
    )
    const unrecognized = (
      database
        .prepare(
          `SELECT root_id, file_path
             FROM library_unrecognized_files
            WHERE library_id = ?
            ORDER BY normalized_path`
        )
        .all(libraryId) as Array<{ root_id: number; file_path: string }>
    ).map((row) => ({ rootId: row.root_id, filePath: row.file_path }))
    return { summary, audit, unrecognized }
  })()
}

export function libraryUnrecognizedFileExists(
  libraryId: number,
  normalizedPath: string
): boolean {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0 || !normalizedPath) return false
  return Boolean(
    getDb()
      .prepare(
        `SELECT 1
           FROM library_unrecognized_files
          WHERE library_id = ? AND normalized_path = ?
          LIMIT 1`
      )
      .get(libraryId, normalizedPath)
  )
}

export function removeLibraryUnrecognizedFile(
  libraryId: number,
  rootId: number,
  normalizedPath: string
): boolean {
  if (
    !Number.isSafeInteger(libraryId) ||
    libraryId <= 0 ||
    !Number.isSafeInteger(rootId) ||
    rootId <= 0 ||
    !normalizedPath
  ) {
    return false
  }
  return (
    getDb()
      .prepare(
        `DELETE FROM library_unrecognized_files
          WHERE library_id = ? AND root_id = ? AND normalized_path = ?`
      )
      .run(libraryId, rootId, normalizedPath).changes > 0
  )
}

/** Keep the editable pending row attached to the successfully renamed file. */
export function renameLibraryUnrecognizedFile(
  libraryId: number,
  rootId: number,
  oldNormalizedPath: string,
  file: Pick<LibraryUnrecognizedFileInput, 'filePath' | 'normalizedPath'>
): void {
  getDb().prepare(`UPDATE library_unrecognized_files
    SET file_path = ?, normalized_path = ?
    WHERE library_id = ? AND root_id = ? AND normalized_path = ?`)
    .run(file.filePath, file.normalizedPath, libraryId, rootId, oldNormalizedPath)
}
