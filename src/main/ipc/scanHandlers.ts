import { IPC } from '@shared/ipc-channels'
import type { ManualImportResult, RenameImportResult, ScanResult } from '@shared/libraryTypes'
import { importManual, renameAndImport } from '../scanner/scanner'
import { scanCoordinator } from '../scanner/scanCoordinator'
import { maintenanceTaskGate } from '../services/maintenanceTaskGate'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import { getSettings } from '../settings/settingsStore'
import { assertConfiguredLibraryFile, assertFileNameOnly } from './ipcPathGuards'

export function registerScanHandlers(ctx: IpcContext): void {
  appCommandAdapter.register(IPC.SCAN_RUN, async (folders): Promise<ScanResult> => {
    const win = ctx.getWindow()
    return scanCoordinator.run({
      folders,
      trigger: 'manual',
      onProgress: (progress) =>
        appEventAdapter.send(win?.webContents, IPC.SCAN_PROGRESS, progress)
    })
  })

  appCommandAdapter.register(IPC.SCAN_CANCEL, (): boolean => scanCoordinator.cancel())

  appCommandAdapter.register(
    IPC.FILE_RENAME,
    (oldPath, newName): Promise<RenameImportResult> => {
      assertConfiguredLibraryFile(oldPath, getSettings().libraryPaths)
      assertFileNameOnly(newName)
      return maintenanceTaskGate.run('resource-maintenance', () =>
        renameAndImport(oldPath, newName)
      )
    }
  )

  appCommandAdapter.register(
    IPC.FILE_IMPORT_MANUAL,
    (filePath, code): Promise<ManualImportResult> => {
      assertConfiguredLibraryFile(filePath, getSettings().libraryPaths)
      return maintenanceTaskGate.run('resource-maintenance', () => importManual(filePath, code))
    }
  )
}
