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
  listVideoFileRefs,
  listVideoResources,
  removeVideoResourceRecord,
  setPrimaryVideoResource
} from '../db/videoRepo'
import { getSettings, updateSettings } from '../settings/settingsStore'
import { maintenanceTaskGate, type MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import {
  consumePendingLibraryPathCleanups,
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
  file_id: number
  file_path: string
}

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
  pathExists: (filePath: string) => boolean
  consumePendingPathCleanups: () => PendingLibraryPathCleanupResult
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
          signal: controller.signal
        }
      )
      result.offlineFolders = offlineFolders
      result.promoted ??= 0
      result.deletedVideos ??= 0
      if (controller.signal.aborted || result.cancelled) {
        result.cancelled = true
        this.recordSummary(trigger, startedAt, 'cancelled', result)
        return result
      }

      this.removeMissingAccessibleResources(result, accessibleFolders, offlineFolders)
      if (isFullScan) {
        const deferredCleanup = this.dependencies.consumePendingPathCleanups()
        result.removed += deferredCleanup.removed
        result.promoted += deferredCleanup.promoted
      }
      if (
        isFullScan &&
        offlineFolders.length === 0 &&
        this.dependencies.shouldAutoDeleteResourceLessVideos()
      ) {
        result.deletedVideos = this.dependencies.deleteResourceLessVideos()
      }
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
      relocated: 0,
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
      resourcesUpdated: result.relocated,
      resourcesRemoved: result.removed,
      primaryResourcesPromoted: result.promoted,
      videosDeleted: result.deletedVideos,
      skippedFiles: result.skipped,
      failedFiles: result.failed,
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
    result: ScanResult,
    accessibleFolders: string[],
    offlineFolders: string[]
  ): void {
    for (const ref of this.dependencies.listLocalResources()) {
      if (offlineFolders.some((folder) => isPathUnderRoot(ref.file_path, folder))) continue
      if (!accessibleFolders.some((folder) => isPathUnderRoot(ref.file_path, folder))) continue
      if (this.dependencies.pathExists(ref.file_path)) continue

      const resource = this.dependencies.getResourceById(ref.file_id)
      if (!resource || resource.kind !== 'local') continue
      const remaining = this.dependencies
        .listResources(ref.video_id)
        .filter((item) => item.id !== resource.id)
      this.dependencies.removeResourceRecord(resource.id)
      result.removed += 1
      if (!resource.is_primary) continue
      const promoted = selectPrimaryVideoResourceCandidate(remaining, this.dependencies.pathExists)
      if (!promoted) continue
      this.dependencies.setPrimaryResource(ref.video_id, promoted.id)
      result.promoted += 1
    }
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
    listLocalResources: dependencies.listLocalResources ?? listVideoFileRefs,
    getResourceById: dependencies.getResourceById ?? getVideoResourceById,
    listResources: dependencies.listResources ?? listVideoResources,
    removeResourceRecord: dependencies.removeResourceRecord ?? removeVideoResourceRecord,
    setPrimaryResource: dependencies.setPrimaryResource ?? setPrimaryVideoResource,
    pathExists: dependencies.pathExists ?? fs.existsSync,
    consumePendingPathCleanups:
      dependencies.consumePendingPathCleanups ?? consumePendingLibraryPathCleanups,
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
