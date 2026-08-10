import fs from 'node:fs'
import path from 'node:path'
import type { ScanProgress, ScanResult } from '@shared/libraryTypes'
import type { VideoResource } from '@shared/videoTypes'
import {
  getVideoResourceById,
  listVideoFileRefs,
  listVideoResources,
  removeVideoResourceRecord,
  setPrimaryVideoResource
} from '../db/videoRepo'
import { getSettings } from '../settings/settingsStore'
import { maintenanceTaskGate, type MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import { scanFolders, type ScanOptions, type ScanProgressFn } from './scanner'

export type ScanTrigger = 'manual' | 'startup' | 'interval' | 'resume'

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
  gate: MaintenanceTaskGate
}

function isUnderFolder(filePath: string, folder: string): boolean {
  const resolvedFile = path.resolve(filePath)
  const resolvedFolder = path.resolve(folder)
  return resolvedFile === resolvedFolder || resolvedFile.startsWith(resolvedFolder + path.sep)
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

    const folders = request.folders?.length
      ? Array.from(new Set(request.folders))
      : Array.from(new Set(this.dependencies.getConfiguredFolders()))
    if (folders.length === 0) {
      lease.release()
      throw new Error('尚未配置媒体库路径')
    }

    const controller = new AbortController()
    this.activeController = controller
    try {
      const accessibleFolders: string[] = []
      const offlineFolders: string[] = []
      for (const folder of folders) {
        if (controller.signal.aborted) return this.cancelledResult(offlineFolders)
        if (await this.dependencies.inspectFolder(folder)) accessibleFolders.push(folder)
        else offlineFolders.push(folder)
      }

      const result = await this.dependencies.scanFolders(
        accessibleFolders,
        request.onProgress,
        {
          signal: controller.signal
        }
      )
      result.offlineFolders = offlineFolders
      result.promoted ??= 0
      if (controller.signal.aborted || result.cancelled) {
        result.cancelled = true
        return result
      }

      this.removeMissingAccessibleResources(result, accessibleFolders, offlineFolders)
      return result
    } finally {
      if (this.activeController === controller) this.activeController = null
      lease.release()
    }
  }

  private cancelledResult(offlineFolders: string[]): ScanResult {
    return {
      scannedFiles: 0,
      imported: 0,
      skipped: 0,
      skippedShort: 0,
      failed: 0,
      cancelled: true,
      relocated: 0,
      removed: 0,
      promoted: 0,
      offlineFolders,
      newCodes: [],
      unrecognizedFiles: []
    }
  }

  private removeMissingAccessibleResources(
    result: ScanResult,
    accessibleFolders: string[],
    offlineFolders: string[]
  ): void {
    for (const ref of this.dependencies.listLocalResources()) {
      if (offlineFolders.some((folder) => isUnderFolder(ref.file_path, folder))) continue
      if (!accessibleFolders.some((folder) => isUnderFolder(ref.file_path, folder))) continue
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
    inspectFolder: dependencies.inspectFolder ?? inspectReadableDirectory,
    scanFolders: dependencies.scanFolders ?? scanFolders,
    listLocalResources: dependencies.listLocalResources ?? listVideoFileRefs,
    getResourceById: dependencies.getResourceById ?? getVideoResourceById,
    listResources: dependencies.listResources ?? listVideoResources,
    removeResourceRecord: dependencies.removeResourceRecord ?? removeVideoResourceRecord,
    setPrimaryResource: dependencies.setPrimaryResource ?? setPrimaryVideoResource,
    pathExists: dependencies.pathExists ?? fs.existsSync,
    gate: dependencies.gate ?? maintenanceTaskGate
  })
}

export const scanCoordinator = createScanCoordinator()
