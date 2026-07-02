import { IPC } from '@shared/ipc-channels'
import type { ManualImportResult, RenameImportResult, ScanResult } from '@shared/types'
import { getSettings } from '../settings/settingsStore'
import { importManual, renameAndImport, scanFolders } from '../scanner/scanner'
import { registerHandler, type IpcContext } from './shared'

let activeScan: AbortController | null = null

export function registerScanHandlers(ctx: IpcContext): void {
  registerHandler(IPC.SCAN_RUN, async (_e, folders?: string[]): Promise<ScanResult> => {
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
          win?.webContents.send(IPC.SCAN_PROGRESS, p)
        },
        { signal: controller.signal }
      )
    } finally {
      if (activeScan === controller) activeScan = null
    }
  })

  registerHandler(IPC.SCAN_CANCEL, (): boolean => {
    if (!activeScan) return false
    activeScan.abort()
    return true
  })

  registerHandler(
    IPC.FILE_RENAME,
    (_e, oldPath: string, newName: string): RenameImportResult =>
      renameAndImport(oldPath, newName)
  )

  registerHandler(
    IPC.FILE_IMPORT_MANUAL,
    (_e, filePath: string, code: string): ManualImportResult => importManual(filePath, code)
  )
}
