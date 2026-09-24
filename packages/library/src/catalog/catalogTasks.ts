import type Database from 'better-sqlite3'
import type { CatalogTaskSnapshot, CatalogTaskState } from '@shared/protocol/tasks'
import { CATALOG_TASK_STATES } from '@shared/protocol/tasks'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { readCatalogIdentity } from './catalogIdentity'


interface TaskRow {
  task_id: string
  catalog_id: string
  snapshot_json: string
  state: CatalogTaskState
  library_id: number | null
  kind: string
  run_id: string | null
  updated_at: string
}

function parseSnapshot(row: TaskRow): CatalogTaskSnapshot {
  return JSON.parse(row.snapshot_json) as CatalogTaskSnapshot
}

function nowIso(): string {
  return new Date().toISOString()
}

export function putCatalogTask(
  snapshot: CatalogTaskSnapshot,
  extras: { runId?: string | null } = {},
  database: Database.Database = getDb()
): CatalogTaskSnapshot {
  if (!CATALOG_TASK_STATES.includes(snapshot.state)) {
    throw structuredError('INVALID_INPUT', '未知的任务状态')
  }
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化')
  const catalogId = snapshot.catalogId || identity.catalogId
  const frozen: CatalogTaskSnapshot = { ...snapshot, catalogId, owner: 'catalog' }
  const timestamp = nowIso()
  database
    .prepare(
      `INSERT INTO catalog_tasks (
         task_id, catalog_id, operation_id, library_id, kind, state, task_revision,
         progress_seq, label, counts_json, error_code, run_id, snapshot_json, created_at, updated_at
       ) VALUES (
         @taskId, @catalogId, @operationId, @libraryId, @kind, @state, @taskRevision,
         @progressSeq, @label, @countsJson, @errorCode, @runId, @snapshot, @createdAt, @updatedAt
       )
       ON CONFLICT(task_id) DO UPDATE SET
         catalog_id = excluded.catalog_id,
         operation_id = excluded.operation_id,
         library_id = excluded.library_id,
         kind = excluded.kind,
         state = excluded.state,
         task_revision = excluded.task_revision,
         progress_seq = excluded.progress_seq,
         label = excluded.label,
         counts_json = excluded.counts_json,
         error_code = excluded.error_code,
         run_id = COALESCE(excluded.run_id, catalog_tasks.run_id),
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at`
    )
    .run({
      taskId: frozen.taskId,
      catalogId,
      operationId: frozen.operationId ?? null,
      libraryId: frozen.libraryId ?? null,
      kind: frozen.kind,
      state: frozen.state,
      taskRevision: frozen.taskRevision,
      progressSeq: frozen.progressSeq,
      label: frozen.label ?? null,
      countsJson: frozen.counts ? JSON.stringify(frozen.counts) : null,
      errorCode: frozen.errorCode ?? null,
      runId: extras.runId ?? null,
      snapshot: JSON.stringify(frozen),
      createdAt: timestamp,
      updatedAt: timestamp
    })
  return frozen
}

export function readCatalogTask(
  taskId: string,
  database: Database.Database = getDb()
): CatalogTaskSnapshot | null {
  const row = database
    .prepare(
      `SELECT task_id, catalog_id, snapshot_json, state, library_id, kind, run_id, updated_at
         FROM catalog_tasks WHERE task_id = ?`
    )
    .get(taskId) as TaskRow | undefined
  return row ? parseSnapshot(row) : null
}

export function readCatalogTaskByRunId(
  runId: string,
  database: Database.Database = getDb()
): CatalogTaskSnapshot | null {
  const row = database
    .prepare(
      `SELECT task_id, catalog_id, snapshot_json, state, library_id, kind, run_id, updated_at
         FROM catalog_tasks WHERE run_id = ? ORDER BY updated_at DESC LIMIT 1`
    )
    .get(runId) as TaskRow | undefined
  return row ? parseSnapshot(row) : null
}

export function listCatalogTasks(
  input: { libraryId?: number; limit?: number; offset?: number } = {},
  database: Database.Database = getDb()
): CatalogTaskSnapshot[] {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
  const offset = Math.max(input.offset ?? 0, 0)
  const rows = input.libraryId
    ? (database
        .prepare(
          `SELECT task_id, catalog_id, snapshot_json, state, library_id, kind, run_id, updated_at
             FROM catalog_tasks
            WHERE library_id = ?
            ORDER BY updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(input.libraryId, limit, offset) as TaskRow[])
    : (database
        .prepare(
          `SELECT task_id, catalog_id, snapshot_json, state, library_id, kind, run_id, updated_at
             FROM catalog_tasks
            ORDER BY updated_at DESC
            LIMIT ? OFFSET ?`
        )
        .all(limit, offset) as TaskRow[])
  return rows.map(parseSnapshot)
}

export function catalogTaskRunId(
  taskId: string,
  database: Database.Database = getDb()
): string | null {
  const row = database
    .prepare('SELECT run_id FROM catalog_tasks WHERE task_id = ?')
    .get(taskId) as { run_id: string | null } | undefined
  return row?.run_id ?? null
}

export function hasOpenCatalogMaintenance(database: Database.Database = getDb()): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS busy FROM catalog_tasks
        WHERE state IN ('queued', 'running', 'cancelRequested')
        LIMIT 1`
    )
    .get() as { busy: number } | undefined
  return Boolean(row)
}

export function recoverCatalogTasks(database: Database.Database = getDb()): {
  scanTasks: number
  inspectionTasks: number
} {
  const identity = readCatalogIdentity(database)
  if (!identity) return { scanTasks: 0, inspectionTasks: 0 }
  let scanTasks = 0
  let inspectionTasks = 0
  const open = database
    .prepare(
      `SELECT task_id, catalog_id, snapshot_json, state, library_id, kind, run_id, updated_at
         FROM catalog_tasks
        WHERE state IN ('queued', 'running', 'cancelRequested')`
    )
    .all() as TaskRow[]
  for (const row of open) {
    const snapshot = parseSnapshot(row)
    if (snapshot.kind === 'scan') {
      const run = row.run_id
        ? (database
            .prepare('SELECT status, error_summary FROM library_scan_runs WHERE id = ?')
            .get(row.run_id) as { status: string; error_summary: string | null } | undefined)
        : undefined
      let state: CatalogTaskState = 'failed'
      if (run?.status === 'cancelled') state = 'cancelled'
      else if (run?.status === 'completed') state = 'succeeded'
      else if (snapshot.state === 'cancelRequested') state = 'cancelled'
      putCatalogTask(
        {
          ...snapshot,
          state,
          taskRevision: snapshot.taskRevision + 1,
          errorCode: state === 'failed' ? 'INTERRUPTED' : snapshot.errorCode,
          label: snapshot.label
        },
        { runId: row.run_id },
        database
      )
      scanTasks += 1
      continue
    }
    putCatalogTask(
      {
        ...snapshot,
        state: 'needsInspection',
        taskRevision: snapshot.taskRevision + 1,
        errorCode: 'NEEDS_INSPECTION',
        label: snapshot.label
      },
      { runId: row.run_id },
      database
    )
    inspectionTasks += 1
  }
  return { scanTasks, inspectionTasks }
}
