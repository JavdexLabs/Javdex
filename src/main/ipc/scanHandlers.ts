import fs from 'node:fs'
import { shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { ManualImportResult, RenameImportResult, ScanResult } from '@shared/libraryTypes'
import { normalizeAbsoluteLocalPath, normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import {
  getLatestLibraryScanSnapshot,
  libraryUnrecognizedFileExists,
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '../db/libraryScanRepo'
import { getMediaLibraryRoot } from '../db/mediaLibraryRepo'
import { listPendingScanGroups, resolvePendingScanGroup } from '../db/pendingScanRepo'
import { listPendingResourceIdentities } from '../db/pendingResourceIdentityRepo'
import { listVideoResources } from '../db/videoRepo'
import {
  libraryScanAuditContainsPath,
  readLibraryScanAudit
} from '../scanner/libraryScanAuditStore'
import { importManual, renameAndImport } from '../scanner/scanner'
import { scanCoordinator } from '../scanner/scanCoordinator'
import { maintenanceTaskGate } from '../services/maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import { resolvePendingResourceIdentity } from '../services/pendingResourceIdentityService'
import { appCommandAdapter, appEventAdapter } from './appContractAdapter'
import { assertFileNameOnly, assertMediaLibraryRootFile } from './ipcPathGuards'
import type { IpcContext } from './shared'

function requireActiveRoot(libraryId: number, rootId: number): MediaLibraryRoot {
  const root = getMediaLibraryRoot(libraryId, rootId)
  if (!root || root.state !== 'active') {
    throw new Error('媒体库根目录不存在、已停用或不属于该媒体库')
  }
  return root
}

function removeScopedUnrecognizedFile(libraryId: number, rootId: number, filePath: string): void {
  removeLibraryUnrecognizedFile(libraryId, rootId, normalizeLocalPathIdentity(filePath))
}

export function registerScanLatestHandler(
  commandAdapter: Pick<typeof appCommandAdapter, 'register'> = appCommandAdapter,
  readLatest: typeof getLatestLibraryScanSnapshot = getLatestLibraryScanSnapshot
): void {
  commandAdapter.register(IPC.SCAN_LATEST_GET, (libraryId) => readLatest(libraryId))
}

export function registerScanHandlers(ctx: IpcContext): void {
  scanCoordinator.subscribe((event) => {
    const webContents = ctx.getWindow()?.webContents
    appEventAdapter.send(webContents, IPC.SCAN_STATE_CHANGED, event)
    if (event.phase === 'progress') {
      appEventAdapter.send(webContents, IPC.SCAN_PROGRESS, {
        libraryId: event.libraryId,
        runId: event.runId,
        progress: event.progress
      })
    }
  })

  appCommandAdapter.register(
    IPC.SCAN_RUN,
    async (libraryId, rootIds): Promise<ScanResult> =>
      scanCoordinator.run({ libraryId, rootIds, trigger: 'manual' })
  )

  appCommandAdapter.register(IPC.SCAN_CANCEL, (runId): boolean => scanCoordinator.cancel(runId))
  registerScanLatestHandler()
  appCommandAdapter.register(IPC.SCAN_AUDIT_GET, (libraryId) =>
    readLibraryScanAudit(libraryId)
  )
  appCommandAdapter.register(IPC.SCAN_AUDIT_REVEAL_FILE, (libraryId, filePath) => {
    let normalizedPath: string
    try {
      normalizedPath = normalizeAbsoluteLocalPath(filePath).normalizedPath
    } catch {
      return { ok: false, error: '路径不属于该媒体库最近一次扫描审计' }
    }
    const audit = readLibraryScanAudit(libraryId)
    const allowed =
      Boolean(audit && libraryScanAuditContainsPath(audit, filePath)) ||
      libraryUnrecognizedFileExists(libraryId, normalizedPath)
    if (!allowed) return { ok: false, error: '路径不属于该媒体库最近一次扫描审计' }
    if (!fs.existsSync(filePath)) return { ok: false, fileMissing: true }
    shell.showItemInFolder(filePath)
    return { ok: true }
  })
  appCommandAdapter.register(IPC.PENDING_SCAN_LIST, (libraryId) =>
    listPendingScanGroups(libraryId)
  )
  appCommandAdapter.register(IPC.PENDING_SCAN_RESOLVE, (libraryId, groupId, resolution) =>
    maintenanceTaskGate.runSync('resource-maintenance', () =>
      resolvePendingScanGroup(libraryId, groupId, resolution, {
        selectFallbackPrimaryResourceId: (candidateLibraryId, videoId) =>
          selectPrimaryVideoResourceCandidate(
            listVideoResources(candidateLibraryId, videoId),
            fs.existsSync
          )?.id ?? null
      })
    )
  )
  appCommandAdapter.register(IPC.PENDING_RESOURCE_IDENTITY_LIST, (libraryId) =>
    listPendingResourceIdentities(libraryId)
  )
  appCommandAdapter.register(
    IPC.PENDING_RESOURCE_IDENTITY_RESOLVE,
    (libraryId, identityId, resolution) =>
      maintenanceTaskGate.run('resource-maintenance', () =>
        resolvePendingResourceIdentity(libraryId, identityId, resolution)
      )
  )

  appCommandAdapter.register(
    IPC.FILE_RENAME,
    (libraryId, rootId, oldPath, newName): Promise<RenameImportResult> => {
      const root = requireActiveRoot(libraryId, rootId)
      assertMediaLibraryRootFile(oldPath, root)
      assertFileNameOnly(newName)
      return maintenanceTaskGate.run('resource-maintenance', async () => {
        const result = await renameAndImport({
          libraryId,
          rootId,
          oldPath,
          newName
        })
        if (result.outcome === 'imported' || result.outcome === 'pending') {
          removeScopedUnrecognizedFile(libraryId, rootId, oldPath)
        } else {
          renameLibraryUnrecognizedFile(libraryId, rootId, normalizeLocalPathIdentity(oldPath), {
            filePath: result.newPath,
            normalizedPath: normalizeLocalPathIdentity(result.newPath)
          })
        }
        return result
      })
    }
  )

  appCommandAdapter.register(
    IPC.FILE_IMPORT_MANUAL,
    (libraryId, rootId, filePath, code, target): Promise<ManualImportResult> => {
      const root = requireActiveRoot(libraryId, rootId)
      assertMediaLibraryRootFile(filePath, root)
      return maintenanceTaskGate.run('resource-maintenance', async () => {
        const result = await importManual({ libraryId, rootId, filePath, code, target })
        if (result.imported || result.skippedPath) {
          removeScopedUnrecognizedFile(libraryId, rootId, filePath)
        }
        return result
      })
    }
  )
}
