import { catalogReadService } from '../services/catalogReadService'
import { SCAN_AUDIT_READ_LIMITS } from '../services/scanAuditReadPolicy'
import fs from 'node:fs'
import { shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type { ManualImportResult, RenameImportResult, ScanCompletionResult } from '@shared/libraryTypes'
import { normalizeAbsoluteLocalPath, normalizeLocalPathIdentity } from '@library/localPathIdentity'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import {
  getLatestLibraryScanSnapshot,
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '@library/db/libraryScanRepo'
import { getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { pagePendingScanQueue, countPendingScanQueue } from '@library/db/pendingScanQueueRepo'
import { getPendingAuditPresence } from '@library/db/pendingAuditRepo'
import { listPendingScanGroups, getPendingScanGroup, resolvePendingScanGroup } from '@library/db/pendingScanRepo'
import { listPendingResourceIdentities, getPendingResourceIdentity } from '@library/db/pendingResourceIdentityRepo'
import { listVideoResources } from '@library/db/videoRepo'
import {
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

export function registerScanAuditReadHandlers(
  commandAdapter: Pick<typeof appCommandAdapter, 'register'> = appCommandAdapter,
  reader: Pick<typeof catalogReadService, 'readAuditHeader' | 'readAuditPage' | 'readAuditViewPage'> = catalogReadService
): void {
  commandAdapter.register(IPC.SCAN_AUDIT_HEADER, libraryId => reader.readAuditHeader(libraryId))
  commandAdapter.register(IPC.SCAN_AUDIT_PAGE, (snapshot, query) => reader.readAuditPage(snapshot, query, SCAN_AUDIT_READ_LIMITS))
  commandAdapter.register(IPC.SCAN_AUDIT_VIEW_PAGE, (snapshot, query) =>
    reader.readAuditViewPage(snapshot, query, SCAN_AUDIT_READ_LIMITS))
}

export function registerScanAuditRevealHandler(
  commandAdapter: Pick<typeof appCommandAdapter, 'register'> = appCommandAdapter,
  reader: Pick<typeof catalogReadService, 'canRevealAuditPath'> = catalogReadService,
  access: (filePath: string) => Promise<void> = filePath => fs.promises.access(filePath),
  reveal: (filePath: string) => void = filePath => shell.showItemInFolder(filePath)
): void {
  commandAdapter.register(IPC.SCAN_AUDIT_REVEAL_FILE, async (libraryId, filePath) => {
    try {
      normalizeAbsoluteLocalPath(filePath)
    } catch {
      return { ok: false, error: '路径不属于该媒体库最近一次扫描审计' }
    }
    let allowed: boolean
    try {
      allowed = await reader.canRevealAuditPath(libraryId, filePath)
    } catch {
      return { ok: false, error: '无法验证路径是否属于该媒体库最近一次扫描审计' }
    }
    if (!allowed) return { ok: false, error: '路径不属于该媒体库最近一次扫描审计' }
    try {
      await access(filePath)
    } catch {
      return { ok: false, fileMissing: true }
    }
    reveal(filePath)
    return { ok: true }
  })
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
    async (libraryId, rootIds): Promise<ScanCompletionResult> =>
      scanCoordinator.run({ libraryId, rootIds, trigger: 'manual' })
  )

  appCommandAdapter.register(IPC.SCAN_CANCEL, (runId): boolean => scanCoordinator.cancel(runId))
  registerScanLatestHandler()
  registerScanAuditReadHandlers()
  appCommandAdapter.register(IPC.SCAN_AUDIT_GET, (libraryId) =>
    readLibraryScanAudit(libraryId)
  )
  registerScanAuditRevealHandler()
  appCommandAdapter.register(IPC.PENDING_AUDIT_PRESENCE, (libraryId, ids) => getPendingAuditPresence(libraryId, ids))
  appCommandAdapter.register(IPC.PENDING_SCAN_QUEUE_PAGE, (query) => pagePendingScanQueue(query))
  appCommandAdapter.register(IPC.PENDING_SCAN_QUEUE_COUNT, (libraryId) => countPendingScanQueue(libraryId))
  appCommandAdapter.register(IPC.PENDING_SCAN_GET, (libraryId, groupId) => getPendingScanGroup(libraryId, groupId))
  appCommandAdapter.register(IPC.PENDING_RESOURCE_IDENTITY_GET, (libraryId, identityId) => getPendingResourceIdentity(libraryId, identityId))
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
