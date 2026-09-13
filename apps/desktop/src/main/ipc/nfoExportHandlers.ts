import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type {
  NfoExportPlanPreview,
  NfoExportPreferences,
  NfoExportReport
} from '@shared/nfoExportTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import {
  isTerminalCatalogTaskState,
  waitForCatalogTask
} from '../application/catalogTaskProgress'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { nfoExportRepository } from '@library/nfo/export/nfoExportRepository'
import { nfoExportTaskController } from '../nfo/export/nfoExportTaskController'
import { NFO_EXPORT_PROFILES } from '@library/nfo/export/nfoExportProfiles'
import { sanitizeNfoExportMessage } from '@library/nfo/export/nfoExportSafety'
import { nfoExportCommandAdapter, nfoExportEventAdapter } from './nfoExportContractAdapter'
import type { IpcContext } from './shared'

function activePreferences(input: NfoExportPreferences): NfoExportPreferences {
  const active = new Set(nfoExportRepository.listActiveLibraries().map((library) => library.id))
  return {
    ...input,
    libraryIds: Array.from(new Set(input.libraryIds.filter((id) => active.has(id))))
  }
}

function registerDesktopNfoExportHandlers(ctx: IpcContext): void {
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_GET_OPTIONS, () => {
    const settings = getSettings()
    const preferences = activePreferences(settings.nfoExportPreferences)
    if (preferences.libraryIds.length !== settings.nfoExportPreferences.libraryIds.length) {
      updateSettings({ nfoExportPreferences: preferences })
    }
    return {
      libraries: nfoExportRepository.listActiveLibraries(),
      profiles: [...NFO_EXPORT_PROFILES],
      preferences
    }
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_UPDATE_PREFERENCES, (input) => {
    const preferences = activePreferences(input)
    updateSettings({ nfoExportPreferences: preferences })
    return preferences
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_PLAN, (request) => {
    const preferences = activePreferences(request)
    if (preferences.libraryIds.length === 0) throw new Error('请选择至少一个可用媒体库')
    updateSettings({ nfoExportPreferences: preferences })
    try {
      return nfoExportTaskController.plan({ ...request, ...preferences })
    } catch (error) {
      throw new Error(sanitizeNfoExportMessage(error))
    }
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_DISCARD_PLAN, (planId) => {
    nfoExportTaskController.discardPlan(planId)
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_START, (planId) =>
    nfoExportTaskController.start(planId)
  )
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_TERMINATE, (taskId) => {
    nfoExportTaskController.terminate(taskId)
  })
  nfoExportTaskController.onEvent((event) => {
    const webContents = ctx.getWindow()?.webContents
    if ('state' in event) nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_STATE, event)
    else nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_PROGRESS, event)
  })
}

function reportFromTask(task: CatalogTaskSnapshot): NfoExportReport {
  const now = new Date().toISOString()
  return {
    taskId: task.taskId,
    startedAt: now,
    finishedAt: now,
    terminated: task.state === 'cancelled',
    writtenCount: task.counts?.written ?? task.counts?.scanned ?? 0,
    skippedCount: task.counts?.skipped ?? 0,
    failedCount: task.counts?.failed ?? 0,
    items: []
  }
}

const remoteNfoWaits = new Map<string, AbortController>()

async function emitRemoteNfoFinished(
  backend: CatalogBackend,
  taskId: string,
  webContents: WebContents | undefined
): Promise<void> {
  const abort = new AbortController()
  remoteNfoWaits.set(taskId, abort)
  try {
    const task = await waitForCatalogTask({
      backend,
      taskId,
      signal: abort.signal,
      onApplied: (snapshot) => {
        if (isTerminalCatalogTaskState(snapshot.state)) return
        nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_PROGRESS, {
          taskId: snapshot.taskId,
          completed: snapshot.counts?.written ?? snapshot.counts?.scanned ?? 0,
          total: snapshot.counts?.total ?? snapshot.counts?.planned ?? 0
        })
      }
    })
    nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_STATE, {
      taskId,
      state: 'finished',
      report: reportFromTask(task)
    })
  } catch {
    nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_STATE, {
      taskId,
      state: 'finished',
      report: {
        taskId,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        terminated: abort.signal.aborted,
        writtenCount: 0,
        skippedCount: 0,
        failedCount: abort.signal.aborted ? 0 : 1,
        items: []
      }
    })
  } finally {
    remoteNfoWaits.delete(taskId)
  }
}

function registerCatalogNfoExportHandlers(ctx: IpcContext, backend: CatalogBackend): void {
  let lastPlan: { planId: string; planDigest: string } | null = null
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_GET_OPTIONS, () => backend.nfo.getOptions({}))
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_UPDATE_PREFERENCES, (input) =>
    backend.nfo.updatePreferences(input, ipcMutation())
  )
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_PLAN, async (request) => {
    const preview = (await backend.nfo.plan(request, ipcMutation())) as NfoExportPlanPreview & {
      planDigest?: string
    }
    if (!preview.planDigest) {
      throw new Error('NFO 导出计划缺少摘要')
    }
    lastPlan = { planId: preview.planId, planDigest: preview.planDigest }
    return preview
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_DISCARD_PLAN, async (planId) => {
    await backend.nfo.discardPlan({ planId }, ipcMutation())
    if (lastPlan?.planId === planId) lastPlan = null
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_START, async (planId) => {
    if (!lastPlan || lastPlan.planId !== planId) throw new Error('NFO 导出计划不存在或已失效')
    const started = (await backend.nfo.start(
      { planId, planDigest: lastPlan.planDigest },
      ipcMutation()
    )) as { taskId: string }
    const webContents = ctx.getWindow()?.webContents
    nfoExportEventAdapter.send(webContents, IPC.NFO_EXPORT_STATE, {
      taskId: started.taskId,
      state: 'running'
    })
    void emitRemoteNfoFinished(backend, started.taskId, webContents)
    return { taskId: started.taskId }
  })
  nfoExportCommandAdapter.register(IPC.NFO_EXPORT_TERMINATE, (taskId) => {
    remoteNfoWaits.get(taskId)?.abort()
    return backend.nfo.terminate({ taskId }, ipcMutation())
  })
}

export function registerNfoExportHandlers(ctx: IpcContext, backend: CatalogBackend): void {
  if (backend.mode === 'local') {
    registerDesktopNfoExportHandlers(ctx)
    return
  }
  registerCatalogNfoExportHandlers(ctx, backend)
}
