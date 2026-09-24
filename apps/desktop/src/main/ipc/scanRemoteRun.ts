import type { ScanCompletionResult } from '@shared/libraryTypes'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type { CatalogBackend } from '../application/catalogBackend'
import {
  isTerminalCatalogTaskState,
  waitForCatalogTask
} from '../application/catalogTaskProgress'
import { ipcMutation } from '../application/mutationContext'

const remoteScanWaits = new Map<string, AbortController>()

export function abortRemoteCatalogScanWait(taskId: string): boolean {
  const abort = remoteScanWaits.get(taskId)
  if (!abort) return false
  abort.abort()
  return true
}

export async function requestRemoteCatalogScanCancel(
  backend: CatalogBackend,
  taskId: string
): Promise<boolean> {
  await backend.tasks.cancel({ taskId }, ipcMutation())
  return true
}

function completionFromTask(libraryId: number, task: CatalogTaskSnapshot): ScanCompletionResult {
  return {
    libraryId,
    runId: task.taskId,
    scannedFiles: task.counts?.scanned ?? 0,
    imported: task.counts?.imported ?? 0,
    skipped: 0,
    skippedShort: 0,
    failed: task.counts?.failed ?? 0,
    pendingGroups: task.counts?.pending ?? 0,
    pendingResources: 0,
    relocated: 0,
    refreshed: 0,
    removed: 0,
    promoted: 0,
    deletedVideos: 0,
    offlineFolders: [],
    strmFailures: [],
    omittedStrmFailures: 0,
    unrecognizedCount: 0,
    ...(task.state === 'cancelled' ? { cancelled: true } : {})
  }
}

export async function scanRunMutation(backend: CatalogBackend, libraryId: number) {
  const library = (await backend.libraries.get({ libraryId })) as {
    revision: number
    config: { revision: number }
  }
  return ipcMutation(undefined, {
    L: { generation: backend.generation, revision: library.revision },
    C: { generation: backend.generation, revision: library.config.revision },
    G: { generation: backend.generation, revision: 1 }
  })
}

async function waitForRemoteScan(
  backend: CatalogBackend,
  libraryId: number,
  taskId: string,
  onProgress?: (task: CatalogTaskSnapshot) => void,
  signal?: AbortSignal
): Promise<ScanCompletionResult> {
  const task = await waitForCatalogTask({
    backend,
    taskId,
    timeoutMs: null,
    signal,
    onApplied: (snapshot) => {
      if (!isTerminalCatalogTaskState(snapshot.state)) onProgress?.(snapshot)
    }
  })
  if (task.state === 'failed') {
    throw new Error(task.label || '扫描失败')
  }
  return completionFromTask(libraryId, task)
}

export async function runRemoteScanThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  onProgress?: (task: CatalogTaskSnapshot) => void
): Promise<ScanCompletionResult> {
  const accepted = (await backend.libraries.runScan(
    { libraryId },
    await scanRunMutation(backend, libraryId)
  )) as { taskId: string }
  const abort = new AbortController()
  remoteScanWaits.set(accepted.taskId, abort)
  try {
    return await waitForRemoteScan(backend, libraryId, accepted.taskId, onProgress, abort.signal)
  } finally {
    remoteScanWaits.delete(accepted.taskId)
  }
}
