import fs from 'node:fs'
import type {
  LibraryScanSummary,
  LibraryScanTrigger,
  ScanProgress,
  ScanResult
} from '@shared/libraryTypes'
import { sanitizeLibraryScanError } from '@shared/libraryScanSummary'
import type { VideoResource } from '@shared/videoTypes'
import {
  getVideoResourceById,
  listLocalVideoResourceRefs,
  listVideoResources,
  removeVideoResourceRecord,
  setPrimaryVideoResource
} from '../db/videoRepo'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { maintenanceTaskGate, type MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import {
  applyPendingLibraryPathCleanups,
  clearPendingLibraryPathCleanups,
  listPendingLibraryPathCleanupRoots,
  runLibraryScanCleanupTransaction,
  type PendingLibraryPathCleanupResult
} from '../services/libraryPathCleanupService'
import { isPathUnderRoot, isSameLibraryPath } from './libraryPathUtils'
import { scanFolders, type ScanOptions, type ScanProgressFn } from './scanner'
import { deleteResourceLessVideos } from '../services/resourceLessVideoCleanupService'

export type ScanTrigger = LibraryScanTrigger

export interface ScanCoordinatorRequest {
  folders?: string[]
  trigger?: ScanTrigger
  onProgress?: (progress: ScanProgress) => void
}

interface LocalResourceRef {
  video_id: number
  resource_id: number
  locator: string
}

type LocalPathState = 'present' | 'missing' | 'unknown'

interface ScanCoordinatorDependencies {
  getConfiguredFolders: () => string[]
  hasPendingPathCleanups: () => boolean
  inspectFolder: (folder: string) => Promise<boolean>
  scanFolders: (
    folders: string[],
    onProgress?: ScanProgressFn,
    options?: ScanOptions
  ) => Promise<ScanResult>
  listLocalResources: () => LocalResourceRef[]
  getResourceById: (resourceId: number) => VideoResource | null
  listResources: (videoId: number) => VideoResource[]
  removeResourceRecord: (resourceId: number) => void
  setPrimaryResource: (videoId: number, resourceId: number) => void
  inspectPath: (filePath: string) => LocalPathState
  getPendingPathCleanupRoots: () => string[]
  applyPendingPathCleanups: (roots: string[]) => PendingLibraryPathCleanupResult
  clearPendingPathCleanups: (roots: string[]) => void
  runCleanupTransaction: <T>(operation: () => T) => T
  shouldAutoDeleteResourceLessVideos: () => boolean
  deleteResourceLessVideos: () => number
  recordScanSummary: (summary: LibraryScanSummary) => void
  now: () => string
  gate: MaintenanceTaskGate
}

async function inspectReadableDirectory(folder: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(folder)
    if (!stat.isDirectory()) return false
    await fs.promises.access(folder, fs.constants.R_OK)
    await fs.promises.readdir(folder)
    return true
  } catch {
    return false
  }
}

function inspectLocalPath(filePath: string): LocalPathState {
  try {
    fs.statSync(filePath)
    return 'present'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown'
  }
}

export class ScanCoordinator {
  private activeController: AbortController | null = null

  constructor(private readonly dependencies: ScanCoordinatorDependencies) {}

  get running(): boolean {
    return this.activeController !== null
  }

  cancel(): boolean {
    if (!this.activeController) return false
    this.activeController.abort()
    return true
  }

  async run(request: ScanCoordinatorRequest = {}): Promise<ScanResult> {
    const lease = this.dependencies.gate.tryAcquire('scan')
    if (!lease) throw new Error('已有扫描或资源维护任务正在运行')

    const trigger = request.trigger ?? 'manual'
    const startedAt = this.dependencies.now()
    const controller = new AbortController()
    this.activeController = controller
    let result = this.emptyResult()
    let offlineFolders: string[] = []
    try {
      const configuredFolders = Array.from(new Set(this.dependencies.getConfiguredFolders()))
      const folders = request.folders?.length
        ? Array.from(new Set(request.folders))
        : configuredFolders
      const isFullScan =
        folders.length === configuredFolders.length &&
        folders.every((folder) =>
          configuredFolders.some((configured) => isSameLibraryPath(folder, configured))
        )
      if (folders.length === 0 && !this.dependencies.hasPendingPathCleanups()) {
        throw new Error('尚未配置媒体库路径')
      }

      const accessibleFolders: string[] = []
      offlineFolders = []
      for (const folder of folders) {
        if (controller.signal.aborted) {
          result = this.cancelledResult(offlineFolders)
          this.recordSummary(trigger, startedAt, 'cancelled', result)
          return result
        }
        if (await this.dependencies.inspectFolder(folder)) accessibleFolders.push(folder)
        else offlineFolders.push(folder)
      }

      result = await this.dependencies.scanFolders(
        accessibleFolders,
        request.onProgress,
        {
          signal: controller.signal,
          unavailableRoots: offlineFolders
        }
      )
      for (const folder of [...accessibleFolders]) {
        if (await this.dependencies.inspectFolder(folder)) continue
        accessibleFolders.splice(accessibleFolders.indexOf(folder), 1)
        offlineFolders.push(folder)
      }
      result.offlineFolders = offlineFolders
      result.promoted ??= 0
      result.deletedVideos ??= 0
      if (controller.signal.aborted || result.cancelled) {
        result.cancelled = true
        this.recordSummary(trigger, startedAt, 'cancelled', result)
        return result
      }
      const processingFailures = Math.max(
        0,
        result.failed - result.unrecognizedFiles.length
      )
      if (processingFailures > 0) {
        this.recordSummary(
          trigger,
          startedAt,
          'failed',
          result,
          `有 ${processingFailures} 个文件处理失败，已跳过资源清理`
        )
        return result
      }

      const pendingCleanupRoots = isFullScan
        ? this.dependencies.getPendingPathCleanupRoots()
        : []
      const shouldDeleteResourceLessVideos =
        isFullScan &&
        offlineFolders.length === 0 &&
        this.dependencies.shouldAutoDeleteResourceLessVideos()
      const cleanup = this.dependencies.runCleanupTransaction(() => {
        const missingResources = this.removeMissingAccessibleResources(
          accessibleFolders,
          offlineFolders
        )
        const deferredCleanup =
          pendingCleanupRoots.length > 0
            ? this.dependencies.applyPendingPathCleanups(pendingCleanupRoots)
            : { removed: 0, promoted: 0, consumedRoots: [] }
        const deletedVideos = shouldDeleteResourceLessVideos
          ? this.dependencies.deleteResourceLessVideos()
          : 0
        return { missingResources, deferredCleanup, deletedVideos }
      })
      this.dependencies.clearPendingPathCleanups(pendingCleanupRoots)
      result.removed += cleanup.missingResources.removed + cleanup.deferredCleanup.removed
      result.promoted += cleanup.missingResources.promoted + cleanup.deferredCleanup.promoted
      result.deletedVideos = cleanup.deletedVideos
      this.recordSummary(trigger, startedAt, 'success', result)
      return result
    } catch (error) {
      const errorSummary = sanitizeLibraryScanError(error)
      result.offlineFolders = offlineFolders
      this.recordSummary(trigger, startedAt, 'failed', result, errorSummary)
      throw new Error(errorSummary)
    } finally {
      if (this.activeController === controller) this.activeController = null
      lease.release()
    }
  }

  private emptyResult(): ScanResult {
    return {
      scannedFiles: 0,
      imported: 0,
      skipped: 0,
      skippedShort: 0,
      failed: 0,
      pendingGroups: 0,
      pendingResources: 0,
      relocated: 0,
      refreshed: 0,
      removed: 0,
      promoted: 0,
      deletedVideos: 0,
      offlineFolders: [],
      newCodes: [],
      unrecognizedFiles: []
    }
  }

  private cancelledResult(offlineFolders: string[]): ScanResult {
    return {
      ...this.emptyResult(),
      cancelled: true,
      offlineFolders
    }
  }

  private recordSummary(
    trigger: LibraryScanTrigger,
    startedAt: string,
    status: LibraryScanSummary['status'],
    result: ScanResult,
    errorSummary: string | null = null
  ): void {
    const summary: LibraryScanSummary = {
      trigger,
      startedAt,
      finishedAt: this.dependencies.now(),
      status,
      scannedFiles: result.scannedFiles,
      resourcesAdded: result.imported,
      resourcesUpdated: result.relocated + result.refreshed,
      resourcesRemoved: result.removed,
      primaryResourcesPromoted: result.promoted,
      videosDeleted: result.deletedVideos,
      skippedFiles: result.skipped,
      failedFiles: result.failed,
      pendingScanGroups: result.pendingGroups,
      pendingScanResources: result.pendingResources,
      offlineFolders: [...result.offlineFolders],
      errorSummary
    }
    try {
      this.dependencies.recordScanSummary(summary)
    } catch (error) {
      console.error('Failed to persist scan summary:', sanitizeLibraryScanError(error))
    }
  }

  private removeMissingAccessibleResources(
    accessibleFolders: string[],
    offlineFolders: string[]
  ): { removed: number; promoted: number } {
    let removed = 0
    let promoted = 0
    for (const ref of this.dependencies.listLocalResources()) {
      if (offlineFolders.some((folder) => isPathUnderRoot(ref.locator, folder))) continue
      if (!accessibleFolders.some((folder) => isPathUnderRoot(ref.locator, folder))) continue
      const pathState = this.dependencies.inspectPath(ref.locator)
      if (pathState === 'present') continue
      if (pathState === 'unknown') {
        throw new Error(`无法确认本地资源是否存在：${ref.locator}`)
      }

      const resource = this.dependencies.getResourceById(ref.resource_id)
      if (!resource || resource.kind !== 'local') continue
      const remaining = this.dependencies
        .listResources(ref.video_id)
        .filter((item) => item.id !== resource.id)
      this.dependencies.removeResourceRecord(resource.id)
      removed += 1
      if (!resource.is_primary) continue
      const promotedResource = selectPrimaryVideoResourceCandidate(
        remaining,
        (locator) => this.dependencies.inspectPath(locator) === 'present'
      )
      if (!promotedResource) continue
      this.dependencies.setPrimaryResource(ref.video_id, promotedResource.id)
      promoted += 1
    }
    return { removed, promoted }
  }
}

export function createScanCoordinator(
  dependencies: Partial<ScanCoordinatorDependencies> = {}
): ScanCoordinator {
  return new ScanCoordinator({
    getConfiguredFolders: dependencies.getConfiguredFolders ?? (() => getSettings().libraryPaths),
    hasPendingPathCleanups:
      dependencies.hasPendingPathCleanups ??
      (() => getSettings().pendingLibraryPathCleanups.length > 0),
    inspectFolder: dependencies.inspectFolder ?? inspectReadableDirectory,
    scanFolders: dependencies.scanFolders ?? scanFolders,
    listLocalResources: dependencies.listLocalResources ?? listLocalVideoResourceRefs,
    getResourceById: dependencies.getResourceById ?? getVideoResourceById,
    listResources: dependencies.listResources ?? listVideoResources,
    removeResourceRecord: dependencies.removeResourceRecord ?? removeVideoResourceRecord,
    setPrimaryResource: dependencies.setPrimaryResource ?? setPrimaryVideoResource,
    inspectPath: dependencies.inspectPath ?? inspectLocalPath,
    getPendingPathCleanupRoots:
      dependencies.getPendingPathCleanupRoots ?? listPendingLibraryPathCleanupRoots,
    applyPendingPathCleanups:
      dependencies.applyPendingPathCleanups ?? applyPendingLibraryPathCleanups,
    clearPendingPathCleanups:
      dependencies.clearPendingPathCleanups ?? clearPendingLibraryPathCleanups,
    runCleanupTransaction:
      dependencies.runCleanupTransaction ?? runLibraryScanCleanupTransaction,
    shouldAutoDeleteResourceLessVideos:
      dependencies.shouldAutoDeleteResourceLessVideos ??
      (() => getSettings().autoDeleteResourceLessVideos),
    deleteResourceLessVideos:
      dependencies.deleteResourceLessVideos ?? deleteResourceLessVideos,
    recordScanSummary:
      dependencies.recordScanSummary ??
      ((summary) => {
        updateSettings({ lastLibraryScanSummary: summary })
      }),
    now: dependencies.now ?? (() => new Date().toISOString()),
    gate: dependencies.gate ?? maintenanceTaskGate
  })
}

export const scanCoordinator = createScanCoordinator()
