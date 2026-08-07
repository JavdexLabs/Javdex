import { IPC } from '@shared/ipc-channels'
import type { ManualImportResult, RenameImportResult, ScanResult } from '@shared/libraryTypes'
import { getSettings } from '../settings/settingsStore'
import { importManual, renameAndImport, scanFolders } from '../scanner/scanner'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'

let activeScan: AbortController | null = null

export function registerScanHandlers(ctx: IpcContext): void {
  appCommandAdapter.register(IPC.SCAN_RUN, async (folders): Promise<ScanResult> => {
    if (activeScan) throw new Error('Scan is already running')

    const settings = getSettings()
    const target = folders && folders.length ? folders : settings.libraryPaths
    if (!target.length) throw new Error('No media library paths configured')

    const controller = new AbortController()
    activeScan = controller
    const win = ctx.getWindow()

    try {
      return await scanFolders(
        target,
        (p) => {
          appEventAdapter.send(win?.webContents, IPC.SCAN_PROGRESS, p)
        },
        { signal: controller.signal }
      )
    } finally {
      if (activeScan === controller) activeScan = null
    }
  })

  appCommandAdapter.register(IPC.SCAN_CANCEL, (): boolean => {
    if (!activeScan) return false
    activeScan.abort()
    return true
  })

  appCommandAdapter.register(
    IPC.FILE_RENAME,
    (oldPath, newName): Promise<RenameImportResult> =>
      renameAndImport(oldPath, newName)
  )

  appCommandAdapter.register(
    IPC.FILE_IMPORT_MANUAL,
    (filePath, code): Promise<ManualImportResult> =>
      importManual(filePath, code)
  )
}
