import { catalogReadService } from '../services/catalogReadService'
import { SCAN_AUDIT_READ_LIMITS } from '../services/scanAuditReadPolicy'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  ManualImportResult,
  PendingResourceIdentityResolution,
  PendingScanGroupResolution,
  PendingScanQueueQuery,
  RenameImportResult,
  ScanCompletionResult,
  LibraryScanLatestSnapshot
} from '@shared/libraryTypes'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import { normalizeAbsoluteLocalPath, normalizeLocalPathIdentity } from '@library/localPathIdentity'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import {
  getLatestLibraryScanSnapshot,
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '@library/db/libraryScanRepo'
import { getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
import { getPendingAuditPresence } from '@library/db/pendingAuditRepo'
import { getLocalVideoResourceByLocator } from '@library/db/videoRepo'
import { filesRenameDigest } from '@library/catalog/catalogFileMaintenance'
import { isPathUnderRoot } from '@library/scan/libraryPathUtils'
import { renameAndImport } from '../scanner/scanner'
import { scanCoordinator } from '../scanner/scanCoordinator'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
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

function fileMaintenanceVersions(backend: CatalogBackend) {
  return {
    G: { generation: backend.generation, revision: 1 },
    R: { generation: backend.generation, revision: 1 },
    V: { generation: backend.generation, revision: 1 }
  }
}

function toRootRelativePath(libraryId: number, rootId: number, filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath
  const root = requireActiveRoot(libraryId, rootId)
  const base = root.realPath ?? root.path
  const resolved = path.resolve(filePath)
  if (!isPathUnderRoot(resolved, base)) {
    throw structuredError('INVALID_INPUT', '文件不在授权根目录内')
  }
  const relative = path.relative(base, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw structuredError('INVALID_INPUT', '远程文件位置必须是根目录相对路径')
  }
  return relative
}

function pendingResolveVersions(backend: CatalogBackend, qRevision: number) {
  return {
    Q: { generation: backend.generation, revision: qRevision },
    V: { generation: backend.generation, revision: 1 },
    R: { generation: backend.generation, revision: 1 },
    G: { generation: backend.generation, revision: 1 }
  }
}

export async function resolvePendingScanThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  groupId: number,
  resolution: PendingScanGroupResolution
) {
  return backend.libraries.resolvePendingScan(
    {
      libraryId,
      groupId,
      assignments: resolution.assignments,
      primaryResourceIds: resolution.primaryResourceIds,
      expectedRevision: resolution.expectedRevision
    },
    ipcMutation(undefined, pendingResolveVersions(backend, resolution.expectedRevision))
  )
}

export async function resolveResourceIdentityThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  identityId: number,
  resolution: PendingResourceIdentityResolution
) {
  return backend.libraries.resolveResourceIdentity(
    {
      libraryId,
      identityId,
      choice: resolution.choice,
      expectedRevision: resolution.expectedRevision
    },
    ipcMutation(undefined, pendingResolveVersions(backend, resolution.expectedRevision))
  )
}

export function auditGetThroughBackend(backend: CatalogBackend, libraryId: number) {
  return backend.libraries.auditGet({ libraryId })
}

export function getPendingScanThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  groupId: number
) {
  return backend.libraries.getPendingScan({ libraryId, groupId })
}

export function listPendingScansThroughBackend(backend: CatalogBackend, libraryId: number) {
  return backend.libraries.listPendingScans({ libraryId })
}

export function pagePendingScanQueueThroughBackend(
  backend: CatalogBackend,
  query: PendingScanQueueQuery
) {
  return backend.libraries.pagePendingScanQueue(query)
}

export function countPendingScanQueueThroughBackend(
  backend: CatalogBackend,
  libraryId?: number
) {
  return backend.libraries.countPendingScanQueue(libraryId == null ? {} : { libraryId })
}

export function getPendingResourceIdentityThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  identityId: number
) {
  return backend.libraries.getPendingResourceIdentity({ libraryId, identityId })
}

export function listPendingResourceIdentitiesThroughBackend(
  backend: CatalogBackend,
  libraryId: number
) {
  return backend.libraries.listPendingResourceIdentities({ libraryId })
}

export async function importManualThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  rootId: number,
  filePath: string,
  code: string,
  target: VideoResourceImportTarget
): Promise<ManualImportResult> {
  if (path.isAbsolute(filePath) && backend.mode === 'remote') {
    throw structuredError('INVALID_INPUT', '远程文件位置必须是根目录相对路径')
  }
  const relativePath = toRootRelativePath(libraryId, rootId, filePath)
  return backend.libraries.importManual(
    { libraryId, location: { rootId, relativePath }, code, target },
    ipcMutation(undefined, fileMaintenanceVersions(backend))
  ) as Promise<ManualImportResult>
}

export async function renameThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  rootId: number,
  oldPath: string,
  newName: string
): Promise<RenameImportResult> {
  assertFileNameOnly(newName)
  if (backend.mode === 'remote') {
    throw structuredError(
      'UNSUPPORTED_CAPABILITY',
      '远程重命名仍需要资料库资源编号；当前桌面 IPC 只有根目录相对/绝对路径。'
    )
  }
  const root = requireActiveRoot(libraryId, rootId)
  const relativePath = toRootRelativePath(libraryId, rootId, oldPath)
  const locator = path.isAbsolute(oldPath)
    ? oldPath
    : path.resolve(root.realPath ?? root.path, relativePath)
  const resource = getLocalVideoResourceByLocator(libraryId, locator)
  if (!resource) {
    assertMediaLibraryRootFile(oldPath, root)
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
  const location = { rootId, relativePath }
  return backend.libraries.renameFile(
    {
      libraryId,
      resourceId: resource.id,
      location,
      newFileName: newName,
      planId: randomUUID(),
      planDigest: filesRenameDigest({
        libraryId,
        resourceId: resource.id,
        location,
        newFileName: newName
      })
    },
    ipcMutation(undefined, fileMaintenanceVersions(backend))
  ) as Promise<RenameImportResult>
}

export function registerScanLatestHandler(
  commandAdapter: Pick<typeof appCommandAdapter, 'register'> = appCommandAdapter,
  readLatest: (
    libraryId: number
  ) => LibraryScanLatestSnapshot | Promise<LibraryScanLatestSnapshot> = getLatestLibraryScanSnapshot
): void {
  commandAdapter.register(IPC.SCAN_LATEST_GET, (libraryId) => readLatest(libraryId))
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

function waitForLocalScan(libraryId: number): {
  promise: Promise<ScanCompletionResult>
  cancel: () => void
} {
  let unsubscribe = (): void => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<ScanCompletionResult>((resolve, reject) => {
    timer = setTimeout(() => {
      unsubscribe()
      reject(new Error('扫描超时'))
    }, 120_000)
    unsubscribe = scanCoordinator.subscribe((event) => {
      if (event.libraryId !== libraryId) return
      if (event.phase === 'completed') {
        if (timer) clearTimeout(timer)
        unsubscribe()
        resolve(event.result)
      } else if (event.phase === 'failed') {
        if (timer) clearTimeout(timer)
        unsubscribe()
        reject(new Error(event.error))
      }
    })
  })
  return {
    promise,
    cancel: () => {
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
  }
}

async function waitForRemoteScan(
  backend: CatalogBackend,
  libraryId: number,
  taskId: string
): Promise<ScanCompletionResult> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const task = (await backend.tasks.get({ taskId })) as CatalogTaskSnapshot
    if (task.state === 'succeeded' || task.state === 'cancelled' || task.state === 'needsInspection') {
      return completionFromTask(libraryId, task)
    }
    if (task.state === 'failed') {
      throw new Error(task.label || '扫描失败')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('扫描超时')
}

export async function runScanThroughBackend(
  backend: CatalogBackend,
  libraryId: number
): Promise<ScanCompletionResult> {
  if (backend.mode === 'remote') {
    const accepted = (await backend.libraries.runScan({ libraryId }, ipcMutation())) as { taskId: string }
    return waitForRemoteScan(backend, libraryId, accepted.taskId)
  }
  const waiting = waitForLocalScan(libraryId)
  try {
    await backend.libraries.runScan({ libraryId }, ipcMutation())
    return await waiting.promise
  } catch (error) {
    waiting.cancel()
    throw error
  }
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

export function registerScanHandlers(ctx: IpcContext, backend: CatalogBackend): void {
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

  appCommandAdapter.register(IPC.SCAN_RUN, async (libraryId): Promise<ScanCompletionResult> =>
    runScanThroughBackend(backend, libraryId)
  )

  appCommandAdapter.register(IPC.SCAN_CANCEL, (runId): boolean => {
    if (scanCoordinator.cancel(runId)) return true
    if (backend.mode === 'remote') {
      void backend.tasks.cancel({ taskId: runId }, ipcMutation()).catch(() => undefined)
      return true
    }
    return false
  })
  registerScanLatestHandler(appCommandAdapter, (libraryId) => backend.libraries.latestScan({ libraryId }))
  registerScanAuditReadHandlers(appCommandAdapter, {
    readAuditHeader: (libraryId) => backend.libraries.auditHeader({ libraryId }),
    readAuditPage: (snapshot, query, limits) => catalogReadService.readAuditPage(snapshot, query, limits),
    readAuditViewPage: (snapshot, query, limits) =>
      catalogReadService.readAuditViewPage(snapshot, query, limits)
  })
  appCommandAdapter.register(IPC.SCAN_AUDIT_GET, (libraryId) => auditGetThroughBackend(backend, libraryId))
  registerScanAuditRevealHandler()
  appCommandAdapter.register(IPC.PENDING_AUDIT_PRESENCE, (libraryId, ids) => getPendingAuditPresence(libraryId, ids))
  appCommandAdapter.register(IPC.PENDING_SCAN_QUEUE_PAGE, (query) =>
    pagePendingScanQueueThroughBackend(backend, query)
  )
  appCommandAdapter.register(IPC.PENDING_SCAN_QUEUE_COUNT, (libraryId) =>
    countPendingScanQueueThroughBackend(backend, libraryId)
  )
  appCommandAdapter.register(IPC.PENDING_SCAN_GET, (libraryId, groupId) =>
    getPendingScanThroughBackend(backend, libraryId, groupId)
  )
  appCommandAdapter.register(IPC.PENDING_RESOURCE_IDENTITY_GET, (libraryId, identityId) =>
    getPendingResourceIdentityThroughBackend(backend, libraryId, identityId)
  )
  appCommandAdapter.register(IPC.PENDING_SCAN_LIST, (libraryId) =>
    listPendingScansThroughBackend(backend, libraryId)
  )
  appCommandAdapter.register(IPC.PENDING_SCAN_RESOLVE, (libraryId, groupId, resolution) =>
    resolvePendingScanThroughBackend(backend, libraryId, groupId, resolution)
  )
  appCommandAdapter.register(IPC.PENDING_RESOURCE_IDENTITY_LIST, (libraryId) =>
    listPendingResourceIdentitiesThroughBackend(backend, libraryId)
  )
  appCommandAdapter.register(
    IPC.PENDING_RESOURCE_IDENTITY_RESOLVE,
    (libraryId, identityId, resolution) =>
      resolveResourceIdentityThroughBackend(backend, libraryId, identityId, resolution)
  )

  appCommandAdapter.register(IPC.FILE_RENAME, (libraryId, rootId, oldPath, newName) =>
    renameThroughBackend(backend, libraryId, rootId, oldPath, newName)
  )

  appCommandAdapter.register(IPC.FILE_IMPORT_MANUAL, (libraryId, rootId, filePath, code, target) =>
    importManualThroughBackend(backend, libraryId, rootId, filePath, code, target)
  )
}
