import { IPC } from '@shared/ipc-channels'
import fs from 'node:fs'
import { shell } from 'electron'
import type { ManualImportResult, RenameImportResult, ScanResult } from '@shared/libraryTypes'
import { importManual, renameAndImport } from '../scanner/scanner'
import { scanCoordinator } from '../scanner/scanCoordinator'
import { listPendingScanGroups, resolvePendingScanGroup } from '../db/pendingScanRepo'
import { listVideoResources } from '../db/videoRepo'
import { maintenanceTaskGate } from '../services/maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import type { IpcContext } from './shared'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import { getSettings, removeUnrecognizedFileFromSnapshot } from '../settings/settingsStore'
import { assertConfiguredLibraryFile, assertFileNameOnly } from './ipcPathGuards'
import {
  libraryScanAuditContainsPath,
  readLibraryScanAudit
} from '../scanner/libraryScanAuditStore'

export function registerScanHandlers(ctx: IpcContext): void {
  scanCoordinator.subscribe((event) => {
    const webContents = ctx.getWindow()?.webContents
    appEventAdapter.send(webContents, IPC.SCAN_STATE_CHANGED, event)
    if (event.phase === 'progress') {
      appEventAdapter.send(webContents, IPC.SCAN_PROGRESS, event.progress)
    }
  })

  appCommandAdapter.register(IPC.SCAN_RUN, async (folders): Promise<ScanResult> => {
    return scanCoordinator.run({
      folders,
      trigger: 'manual'
    })
  })

  appCommandAdapter.register(IPC.SCAN_CANCEL, (): boolean => scanCoordinator.cancel())
  appCommandAdapter.register(IPC.SCAN_AUDIT_GET, () => readLibraryScanAudit())
  appCommandAdapter.register(IPC.SCAN_AUDIT_REVEAL_FILE, (filePath) => {
    const settings = getSettings()
    const audit = readLibraryScanAudit()
    const allowed =
      Boolean(audit && libraryScanAuditContainsPath(audit, filePath)) ||
      settings.unrecognizedFiles.includes(filePath) ||
      Boolean(settings.lastLibraryScanSummary?.offlineFolders.includes(filePath))
    if (!allowed) return { ok: false, error: '路径不属于最近一次扫描审计' }
    if (!fs.existsSync(filePath)) return { ok: false, fileMissing: true }
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
  appCommandAdapter.register(IPC.PENDING_SCAN_LIST, () => listPendingScanGroups())
  appCommandAdapter.register(IPC.PENDING_SCAN_RESOLVE, (groupId, resolution) =>
    maintenanceTaskGate.runSync('resource-maintenance', () =>
      resolvePendingScanGroup(groupId, resolution, {
        selectFallbackPrimaryResourceId: (videoId) =>
          selectPrimaryVideoResourceCandidate(listVideoResources(videoId), fs.existsSync)?.id ??
          null
      })
    )
  )

  appCommandAdapter.register(
    IPC.FILE_RENAME,
    (oldPath, newName, code, target): Promise<RenameImportResult> => {
      assertConfiguredLibraryFile(oldPath, getSettings().libraryPaths)
      assertFileNameOnly(newName)
      return maintenanceTaskGate.run('resource-maintenance', async () => {
        const result = await renameAndImport(oldPath, newName, code, target)
        if (result.imported) removeUnrecognizedFileFromSnapshot(oldPath)
        return result
      })
    }
  )

  appCommandAdapter.register(
    IPC.FILE_IMPORT_MANUAL,
    (filePath, code, target): Promise<ManualImportResult> => {
      assertConfiguredLibraryFile(filePath, getSettings().libraryPaths)
      return maintenanceTaskGate.run('resource-maintenance', async () => {
        const result = await importManual(filePath, code, target)
        if (result.imported || result.skippedPath) {
          removeUnrecognizedFileFromSnapshot(filePath)
        }
        return result
      })
    }
  )
}
