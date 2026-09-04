import { IPC } from '@shared/ipc-channels'
import type { NfoExportPreferences } from '@shared/nfoExportTypes'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { nfoExportRepository } from '../nfo/export/nfoExportRepository'
import { nfoExportTaskController } from '../nfo/export/nfoExportTaskController'
import { NFO_EXPORT_PROFILES } from '../nfo/export/nfoExportProfiles'
import { sanitizeNfoExportMessage } from '../nfo/export/nfoExportSafety'
import { nfoExportCommandAdapter, nfoExportEventAdapter } from './nfoExportContractAdapter'
import type { IpcContext } from './shared'

function activePreferences(input: NfoExportPreferences): NfoExportPreferences {
  const active = new Set(nfoExportRepository.listActiveLibraries().map((library) => library.id))
  return {
    ...input,
    libraryIds: Array.from(new Set(input.libraryIds.filter((id) => active.has(id))))
  }
}

export function registerNfoExportHandlers(ctx: IpcContext): void {
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
