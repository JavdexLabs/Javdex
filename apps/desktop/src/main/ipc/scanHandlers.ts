import { catalogReadService } from '../services/catalogReadService'
import { SCAN_AUDIT_READ_LIMITS } from '../services/scanAuditReadPolicy'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import { IPC } from '@shared/ipc-channels'
import type {
  ManualImportResult,
  PendingAuditIds,
  PendingResourceIdentityResolution,
  PendingScanGroupResolution,
  PendingScanQueueQuery,
  RenameImportResult,
  ScanCompletionResult,
  LibraryScanLatestSnapshot
} from '@shared/libraryTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import type { ScanAuditIndexQuery, ScanAuditSnapshotIdentity, ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import {
  abortRemoteCatalogScanWait,
  runRemoteScanThroughBackend,
  scanRunMutation
} from './scanRemoteRun'

export { abortRemoteCatalogScanWait, runRemoteScanThroughBackend }
import { structuredError } from '@shared/protocol/errors'
import { normalizeAbsoluteLocalPath, normalizeLocalPathIdentity } from '@library/localPathIdentity'
import type { MediaLibraryRoot } from '@shared/mediaLibraryTypes'
import {
  getLatestLibraryScanSnapshot,
  removeLibraryUnrecognizedFile,
  renameLibraryUnrecognizedFile
} from '@library/db/libraryScanRepo'
import { getMediaLibraryRoot } from '@library/db/mediaLibraryRepo'
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

export function auditPageThroughBackend(
  backend: CatalogBackend,
  snapshot: ScanAuditSnapshotIdentity,
  query: ScanAuditIndexQuery
) {
  if (backend.mode !== 'remote') {
    return catalogReadService.readAuditPage(snapshot, query, SCAN_AUDIT_READ_LIMITS)
  }
  return backend.libraries.auditPage({
    libraryId: snapshot.libraryId,
    section: query.section,
    ...(query.outcome != null ? { outcome: query.outcome } : {}),
    ...(query.attention != null ? { attention: query.attention } : {}),
    ...(query.limit != null ? { limit: query.limit } : {}),
    ...(query.offset != null ? { offset: query.offset } : {})
  })
}

export function auditViewPageThroughBackend(
  backend: CatalogBackend,
  snapshot: ScanAuditSnapshotIdentity,
  query: ScanAuditViewQuery
) {
  if (backend.mode !== 'remote') {
    return catalogReadService.readAuditViewPage(snapshot, query, SCAN_AUDIT_READ_LIMITS)
  }
  return backend.libraries.auditViewPage({
    libraryId: snapshot.libraryId,
    tab: query.tab,
    ...(query.outcome != null ? { outcome: query.outcome } : {}),
    ...(query.changesFilter != null ? { changesFilter: query.changesFilter } : {}),
    ...(query.search != null ? { search: query.search } : {}),
    ...(query.locale != null ? { locale: query.locale } : {}),
    ...(query.limit != null ? { limit: query.limit } : {}),
    ...(query.offset != null ? { offset: query.offset } : {}),
    ...(query.anchor != null ? { anchor: query.anchor } : {})
  })
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

export function pendingAuditPresenceThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  ids: PendingAuditIds
) {
  return backend.libraries.pendingAuditPresence({ libraryId, ...ids })
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

export async function runScanThroughBackend(
  backend: CatalogBackend,
  libraryId: number,
  onProgress?: Parameters<typeof runRemoteScanThroughBackend>[2]
): Promise<ScanCompletionResult> {
  if (backend.mode === 'remote') {
    return runRemoteScanThroughBackend(backend, libraryId, onProgress)
  }
  const waiting = waitForLocalScan(libraryId)
  try {
    await backend.libraries.runScan({ libraryId }, await scanRunMutation(backend, libraryId))
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
    runScanThroughBackend(backend, libraryId, (task) => {
      appEventAdapter.send(ctx.getWindow()?.webContents, IPC.SCAN_PROGRESS, {
        libraryId: task.libraryId ?? libraryId,
        runId: task.taskId,
        progress: {
          scanned: task.counts?.scanned ?? 0,
          imported: task.counts?.imported ?? 0,
          currentFile: task.label ?? ''
        }
      })
    })
  )

  appCommandAdapter.register(IPC.SCAN_CANCEL, (runId): boolean => {
    abortRemoteCatalogScanWait(runId)
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
    readAuditPage: (snapshot, query) => auditPageThroughBackend(backend, snapshot, query),
    readAuditViewPage: (snapshot, query) => auditViewPageThroughBackend(backend, snapshot, query)
  })
  appCommandAdapter.register(IPC.SCAN_AUDIT_GET, (libraryId) => auditGetThroughBackend(backend, libraryId))
  registerScanAuditRevealHandler()
  appCommandAdapter.register(IPC.PENDING_AUDIT_PRESENCE, (libraryId, ids) =>
    pendingAuditPresenceThroughBackend(backend, libraryId, ids)
  )
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
