import { randomUUID } from 'node:crypto'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import {
  catalogTaskRunId,
  hasOpenCatalogMaintenance,
  putCatalogTask,
  readCatalogTask,
  readCatalogTaskByRunId
} from '@library/catalog/catalogTasks'
import { handoffWaitingBlocksNewMaintenance } from '@library/catalog/catalogWriter'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
import { scanCoordinator } from '@library/scan/scanCoordinator'
import type { LibraryScanEvent } from '@shared/libraryTypes'

const started = new Set<string>()
const cancelRequested = new Set<string>()

function identityCatalogId(): string {
  const identity = readCatalogIdentity()
  if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化')
  return identity.catalogId
}

function requireNoHandoffWait(): void {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
}

function bump(snapshot: CatalogTaskSnapshot, patch: Partial<CatalogTaskSnapshot>): CatalogTaskSnapshot {
  return {
    ...snapshot,
    ...patch,
    taskRevision: snapshot.taskRevision + 1
  }
}

function applyScanEvent(event: LibraryScanEvent): void {
  const current =
    readCatalogTaskByRunId(event.runId) ??
    [...started]
      .map((taskId) => readCatalogTask(taskId))
      .find((task) => task?.libraryId === event.libraryId && task.kind === 'scan')
  if (!current) return
  if (event.phase === 'started') {
    putCatalogTask(
      bump(current, {
        state: cancelRequested.has(current.taskId) ? 'cancelRequested' : 'running',
        label: '扫描进行中'
      }),
      { runId: event.runId }
    )
    if (cancelRequested.has(current.taskId)) {
      scanCoordinator.cancel(event.runId)
    }
    return
  }
  if (event.phase === 'progress') {
    putCatalogTask(
      bump(current, {
        progressSeq: current.progressSeq + 1,
        counts: {
          scanned: event.progress.scanned,
          imported: event.progress.imported
        },
        label: event.progress.currentFile || current.label
      }),
      { runId: event.runId }
    )
    return
  }
  if (event.phase === 'completed') {
    const cancelled = Boolean(event.result.cancelled) || cancelRequested.has(current.taskId)
    putCatalogTask(
      bump(current, {
        state: cancelled ? 'cancelled' : 'succeeded',
        progressSeq: current.progressSeq + 1,
        counts: {
          scanned: event.result.scannedFiles,
          imported: event.result.imported,
          failed: event.result.failed,
          pending: event.result.pendingGroups
        },
        label: cancelled ? '扫描已取消' : '扫描完成'
      }),
      { runId: event.runId }
    )
    cancelRequested.delete(current.taskId)
    started.delete(current.taskId)
    return
  }
  putCatalogTask(
    bump(current, {
      state: 'failed',
      errorCode: 'SCAN_FAILED',
      label: event.error
    }),
    { runId: event.runId }
  )
  cancelRequested.delete(current.taskId)
  started.delete(current.taskId)
}

let subscribed = false
function ensureSubscription(): void {
  if (subscribed) return
  scanCoordinator.subscribe(applyScanEvent)
  subscribed = true
}

export function resetCatalogScanRuntime(): void {
  started.clear()
  cancelRequested.clear()
}

export function enqueueLibraryScan(input: {
  libraryId: number
  operationId: string
}): { taskId: string } {
  ensureSubscription()
  requireNoHandoffWait()
  if (maintenanceTaskGate.active || hasOpenCatalogMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '已有扫描或资源维护任务正在运行')
  }
  const taskId = randomUUID()
  putCatalogTask({
    owner: 'catalog',
    taskId,
    operationId: input.operationId,
    catalogId: identityCatalogId(),
    libraryId: input.libraryId,
    kind: 'scan',
    state: 'queued',
    taskRevision: 1,
    progressSeq: 0,
    label: '扫描排队'
  })
  return { taskId }
}

export function startLibraryScan(taskId: string): void {
  ensureSubscription()
  const task = readCatalogTask(taskId)
  if (!task || task.kind !== 'scan') return
  if (task.state !== 'queued' && task.state !== 'cancelRequested') return
  if (cancelRequested.has(taskId) || task.state === 'cancelRequested') {
    putCatalogTask(bump(task, { state: 'cancelled', label: '扫描已取消' }))
    cancelRequested.delete(taskId)
    return
  }
  started.add(taskId)
  void scanCoordinator
    .run({ libraryId: task.libraryId!, trigger: 'manual' })
    .catch((error) => {
      const current = readCatalogTask(taskId)
      if (!current || current.state === 'succeeded' || current.state === 'cancelled') return
      putCatalogTask(
        bump(current, {
          state: 'failed',
          errorCode: 'SCAN_FAILED',
          label: error instanceof Error ? error.message : String(error)
        })
      )
      started.delete(taskId)
      cancelRequested.delete(taskId)
    })
}

export function requestLibraryScanCancel(input: { libraryId: number; taskId?: string }): CatalogTaskSnapshot {
  ensureSubscription()
  const task = input.taskId
    ? readCatalogTask(input.taskId)
    : listActiveScan(input.libraryId)
  if (!task || task.kind !== 'scan') {
    throw structuredError('INVALID_INPUT', '扫描任务不存在')
  }
  if (task.libraryId !== input.libraryId) {
    throw structuredError('INVALID_INPUT', '扫描任务不属于该媒体库')
  }
  if (task.state === 'succeeded' || task.state === 'failed' || task.state === 'cancelled') {
    return task
  }
  cancelRequested.add(task.taskId)
  const next = putCatalogTask(bump(task, { state: 'cancelRequested', label: '已请求取消扫描' }))
  const runId = catalogTaskRunId(task.taskId)
  if (runId) scanCoordinator.cancel(runId)
  else if (started.has(task.taskId)) scanCoordinator.cancel()
  return next
}

function listActiveScan(libraryId: number): CatalogTaskSnapshot | null {
  const row = getDb()
    .prepare(
      `SELECT snapshot_json FROM catalog_tasks
        WHERE library_id = ? AND kind = 'scan'
          AND state IN ('queued', 'running', 'cancelRequested')
        ORDER BY updated_at DESC LIMIT 1`
    )
    .get(libraryId) as { snapshot_json: string } | undefined
  return row ? (JSON.parse(row.snapshot_json) as CatalogTaskSnapshot) : null
}
