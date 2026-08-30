import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  LibraryScanAudit,
  LibraryScanEvent,
  LibraryScanFileAuditEntry,
  LibraryScanPendingGroupAuditEntry,
  LibraryScanResourceAuditEntry,
  LibraryScanSummary,
  LibraryScanTrigger,
  PendingLibraryPathCleanup,
  ScanProgress,
  ScanResult
} from '@shared/libraryTypes'
import { LEGACY_CLEANUP_WAITING_ERROR } from '@shared/legacyLibraryCleanup'
import { sanitizeLibraryScanError } from '@shared/libraryScanSummary'
import { normalizeLocalPathIdentity } from '@shared/localPathIdentity'
import type { MediaLibraryRoot, MediaLibraryScanSnapshot } from '@shared/mediaLibraryTypes'
import type { Video, VideoResource } from '@shared/videoTypes'
import {
  getVideoById,
  getVideoResourceInLibrary,
  listSourceManagedVideoResourceRefs,
  listVideoResources,
  removeVideoResourceRecord,
  setPrimaryVideoResource,
  type LocalVideoResourceRef
} from '../db/videoRepo'
import { getDb } from '../db/database'
import {
  bindOnlineMediaLibraryRootIdentities,
  readMediaLibraryScanSnapshot,
  resolveMediaLibraryRootPath
} from '../db/mediaLibraryRepo'
import {
  removeResourceLessMemberships,
  type RemovedResourceLessMembership
} from '../db/libraryMembershipRepo'
import {
  beginLibraryScanRun,
  finishLibraryScanRun,
  type LibraryUnrecognizedFileInput
} from '../db/libraryScanRepo'
import { listPendingScanGroups, reconcilePendingScanResources } from '../db/pendingScanRepo'
import { maintenanceTaskGate, type MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import {
  authorizeMediaLibraryRoot,
  authorizeMediaLibraryRootDeletionTarget,
  authorizeMediaLibraryRootFile
} from '../services/mediaLibraryRootFileGuard'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import {
  applyPendingLibraryPathCleanups,
  listPendingLibraryPathCleanupRoots,
  recoverLegacyLibraryPathCleanups,
  type RecoverLegacyLibraryPathCleanupResult,
  type PendingLibraryPathCleanupResult
} from '../services/libraryPathCleanupService'
import { isPathUnderRoot } from './libraryPathUtils'
import {
  scanFolders,
  type ScanFoldersRequest,
  type ScanOptions,
  type ScanProgressFn
} from './scanner'
import { resolveMinScanImportDurationSeconds } from './videoDuration'

export type ScanTrigger = LibraryScanTrigger

export interface ScanCoordinatorRequest {
  libraryId: number
  rootIds?: number[]
  trigger?: ScanTrigger
  onProgress?: (progress: ScanProgress) => void
}

type LocalPathState = 'present' | 'missing' | 'unknown'

interface FinishRunInput {
  libraryId: number
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  summary: LibraryScanSummary
  audit: LibraryScanAudit
  replaceUnrecognizedRootIds?: readonly number[]
  unrecognizedFiles?: readonly LibraryUnrecognizedFileInput[]
}

export interface ScanCoordinatorDependencies {
  readScanSnapshot: (libraryId: number) => MediaLibraryScanSnapshot
  bindRootIdentities: typeof bindOnlineMediaLibraryRootIdentities
  inspectRoot: (root: Readonly<MediaLibraryRoot>) => Promise<boolean>
  authorizeRoot: typeof authorizeMediaLibraryRoot
  authorizeRootFile: typeof authorizeMediaLibraryRootFile
  authorizeRootDeletionTarget: typeof authorizeMediaLibraryRootDeletionTarget
  scanFolders: (
    request: ScanFoldersRequest,
    onProgress?: ScanProgressFn,
    options?: ScanOptions
  ) => Promise<ScanResult>
  listLocalResources: (libraryId: number) => LocalVideoResourceRef[]
  getResourceById: (libraryId: number, resourceId: number) => VideoResource | null
  getVideoById: (videoId: number) => Video | null
  listResources: (libraryId: number, videoId: number) => VideoResource[]
  removeResourceRecord: (libraryId: number, resourceId: number) => void
  setPrimaryResource: (libraryId: number, videoId: number, resourceId: number) => void
  inspectPath: (filePath: string) => LocalPathState
  reconcilePendingScanResources: typeof reconcilePendingScanResources
  recoverPendingPathCleanups: (libraryId: number) => RecoverLegacyLibraryPathCleanupResult
  listPendingPathCleanups: (libraryId: number) => PendingLibraryPathCleanup[]
  applyPendingPathCleanups: (
    cleanups: PendingLibraryPathCleanup[]
  ) => PendingLibraryPathCleanupResult
  runCleanupTransaction: <T>(operation: () => T) => T
  removeResourceLessMemberships: (libraryId: number) => RemovedResourceLessMembership[]
  listPendingScanGroups: typeof listPendingScanGroups
  beginRun: typeof beginLibraryScanRun
  finishRun: (input: FinishRunInput) => void
  now: () => string
  createRunId: () => string
  gate: MaintenanceTaskGate
}

async function inspectStableRoot(root: Readonly<MediaLibraryRoot>): Promise<boolean> {
  try {
    const current = resolveMediaLibraryRootPath(root.path)
    if (!current.realPath || !current.normalizedRealPath) return false
    await fs.promises.access(current.realPath, fs.constants.R_OK)
    await fs.promises.readdir(current.realPath)
    if (
      root.normalizedRealPath != null &&
      current.normalizedRealPath !== root.normalizedRealPath
    ) {
      return false
    }
    if (root.deviceId != null && current.deviceId !== root.deviceId) return false
    if (root.inode != null && current.inode !== root.inode) return false
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

function runCleanupTransaction<T>(operation: () => T): T {
  return getDb().transaction(operation)()
}

export class ScanCoordinator {
  private activeRun: { runId: string; controller: AbortController } | null = null
  private readonly listeners = new Set<(event: LibraryScanEvent) => void>()

  constructor(private readonly dependencies: ScanCoordinatorDependencies) {}

  get running(): boolean {
    return this.activeRun !== null
  }

  get activeRunId(): string | null {
    return this.activeRun?.runId ?? null
  }

  subscribe(listener: (event: LibraryScanEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  cancel(runId?: string): boolean {
    if (!this.activeRun || (runId != null && runId !== this.activeRun.runId)) return false
    this.activeRun.controller.abort()
    return true
  }

  async run(request: ScanCoordinatorRequest): Promise<ScanResult> {
    if (!Number.isSafeInteger(request.libraryId) || request.libraryId <= 0) {
      throw new Error('媒体库 ID 无效')
    }
    const lease = this.dependencies.gate.tryAcquire('scan')
    if (!lease) throw new Error('已有扫描或资源维护任务正在运行')

    const trigger = request.trigger ?? 'manual'
    const startedAt = this.dependencies.now()
    const runId = this.dependencies.createRunId()
    const controller = new AbortController()
    this.activeRun = { runId, controller }
    let result = this.emptyResult(request.libraryId, runId)
    const offlineRoots: Readonly<MediaLibraryRoot>[] = []
    let eventFailure: string | null = null
    let snapshot: MediaLibraryScanSnapshot | null = null
    let selectedRoots: Readonly<MediaLibraryRoot>[] = []
    let beganRun = false
    const auditState: Omit<
      LibraryScanAudit,
      | 'schemaVersion'
      | 'libraryId'
      | 'runId'
      | 'configRevision'
      | 'trigger'
      | 'startedAt'
      | 'finishedAt'
      | 'status'
    > = {
      files: [],
      removedResources: [],
      promotedResources: [],
      deletedVideos: [],
      pendingGroups: []
    }

    try {
      const legacyCleanupRecovery = !request.rootIds?.length
        ? this.dependencies.recoverPendingPathCleanups(request.libraryId)
        : { recovered: 0, waiting: 0 }
      snapshot = this.dependencies.readScanSnapshot(request.libraryId)
      selectedRoots = this.selectRoots(snapshot, request.rootIds)
      const unboundRootIds = selectedRoots
        .filter((root) => !root.normalizedRealPath || !root.deviceId || !root.inode)
        .map((root) => root.id)
      if (unboundRootIds.length > 0) {
        const binding = this.dependencies.bindRootIdentities({
          libraryId: request.libraryId,
          rootIds: unboundRootIds,
          expectedRevision: snapshot.libraryRevision
        })
        if (binding.boundRootIds.length > 0) {
          snapshot = this.dependencies.readScanSnapshot(request.libraryId)
          selectedRoots = this.selectRoots(snapshot, request.rootIds)
        }
      }
      const pendingPathCleanups = request.rootIds?.length
        ? []
        : this.dependencies.listPendingPathCleanups(request.libraryId)
      const hasNoRunnableWork = selectedRoots.length === 0 && pendingPathCleanups.length === 0
      if (hasNoRunnableWork && legacyCleanupRecovery.waiting === 0) {
        throw new Error('尚未配置可扫描的媒体库根目录')
      }
      this.dependencies.beginRun({
        libraryId: request.libraryId,
        runId,
        configRevision: snapshot.configRevision,
        trigger,
        startedAt
      })
      beganRun = true
      this.emit({ phase: 'started', libraryId: request.libraryId, runId, trigger })
      if (hasNoRunnableWork) throw new Error(LEGACY_CLEANUP_WAITING_ERROR)

      const accessibleRoots: Readonly<MediaLibraryRoot>[] = []
      for (const root of selectedRoots) {
        if (controller.signal.aborted) {
          result = this.cancelledResult(request.libraryId, runId, offlineRoots)
          this.recordSummary(
            snapshot,
            runId,
            trigger,
            startedAt,
            'cancelled',
            result,
            null,
            auditState,
            []
          )
          return result
        }
        if (await this.dependencies.inspectRoot(root)) accessibleRoots.push(root)
        else offlineRoots.push(root)
      }

      result = await this.dependencies.scanFolders(
        {
          libraryId: request.libraryId,
          runId,
          roots: accessibleRoots
        },
        (progress) => {
          request.onProgress?.(progress)
          this.emit({
            phase: 'progress',
            libraryId: request.libraryId,
            runId,
            trigger,
            progress
          })
        },
        {
          signal: controller.signal,
          unavailableRootIds: offlineRoots.map((root) => root.id),
          minImportDurationSeconds: resolveMinScanImportDurationSeconds(
            snapshot.config.minImportDurationMinutes
          ),
          autoMergeSameCodeResources: snapshot.config.autoMergeSameCodeResources,
          onFileResult: (entry) => auditState.files.push(entry)
        }
      )

      const safeRoots: Readonly<MediaLibraryRoot>[] = []
      for (const root of accessibleRoots) {
        if (await this.dependencies.inspectRoot(root)) safeRoots.push(root)
        else if (!offlineRoots.some((offline) => offline.id === root.id)) offlineRoots.push(root)
      }
      result.offlineFolders = offlineRoots.map((root) => root.path)
      this.refreshPendingAudit(request.libraryId, auditState)
      if (controller.signal.aborted || result.cancelled) {
        result.cancelled = true
        this.recordSummary(
          snapshot,
          runId,
          trigger,
          startedAt,
          'cancelled',
          result,
          null,
          auditState,
          []
        )
        return result
      }

      const processingFailures = Math.max(
        0,
        result.failed -
          result.unrecognizedFiles.length -
          result.strmFailures.length -
          result.omittedStrmFailures
      )
      if (processingFailures > 0) {
        eventFailure = `有 ${processingFailures} 个文件处理失败，已跳过资源清理`
        this.recordSummary(
          snapshot,
          runId,
          trigger,
          startedAt,
          'failed',
          result,
          eventFailure,
          auditState,
          []
        )
        return result
      }

      const isFullScan =
        !request.rootIds?.length &&
        selectedRoots.length === snapshot.roots.length &&
        selectedRoots.every((root) => snapshot?.roots.some((item) => item.id === root.id))
      const safeRootIds = new Set(safeRoots.map((root) => root.id))
      const safeRootsById = new Map(safeRoots.map((root) => [root.id, root] as const))
      const cleanup = this.dependencies.runCleanupTransaction(() => {
        for (const root of safeRoots) {
          this.dependencies.authorizeRoot(request.libraryId, root.id, root)
        }
        const inspectAuthorizedPendingPath = (filePath: string): LocalPathState => {
          const root = safeRoots.find(
            (candidate) =>
              isPathUnderRoot(filePath, candidate.path) ||
              Boolean(candidate.realPath && isPathUnderRoot(filePath, candidate.realPath))
          )
          if (!root) return 'unknown'
          const state = this.dependencies.inspectPath(filePath)
          if (state === 'present') {
            this.dependencies.authorizeRootFile(request.libraryId, root.id, filePath, root)
          } else if (state === 'missing') {
            this.dependencies.authorizeRootDeletionTarget(
              request.libraryId,
              root.id,
              filePath,
              root
            )
          } else {
            this.dependencies.authorizeRoot(request.libraryId, root.id, root)
          }
          return state
        }
        this.dependencies.reconcilePendingScanResources(
          request.libraryId,
          [...safeRootIds],
          inspectAuthorizedPendingPath
        )
        const missingResources = this.removeMissingAccessibleResources(
          request.libraryId,
          safeRootsById
        )
        const deferredCleanup =
          isFullScan && pendingPathCleanups.length > 0
            ? this.dependencies.applyPendingPathCleanups(pendingPathCleanups)
            : { removed: 0, promoted: 0, consumedRoots: [] }
        const removedMemberships =
          isFullScan && offlineRoots.length === 0 && snapshot?.config.removeResourceLessMemberships
            ? this.dependencies.removeResourceLessMemberships(request.libraryId)
            : []
        return { missingResources, deferredCleanup, removedMemberships }
      })
      result.removed += cleanup.missingResources.removed + cleanup.deferredCleanup.removed
      result.promoted += cleanup.missingResources.promoted + cleanup.deferredCleanup.promoted
      result.deletedVideos = cleanup.removedMemberships.length
      auditState.removedResources.push(...cleanup.missingResources.removedResources)
      auditState.promotedResources.push(...cleanup.missingResources.promotedResources)
      auditState.deletedVideos.push(
        ...cleanup.removedMemberships.map((video) => ({
          videoId: video.videoId,
          videoCode: video.videoCode,
          videoTitle: video.videoTitle,
          reason: 'resource_less' as const
        }))
      )
      const status =
        result.strmFailures.length + result.omittedStrmFailures > 0
          ? 'completed_with_errors'
          : 'success'
      this.recordSummary(
        snapshot,
        runId,
        trigger,
        startedAt,
        status,
        result,
        null,
        auditState,
        safeRoots
      )
      return result
    } catch (error) {
      const errorSummary = sanitizeLibraryScanError(error)
      eventFailure = errorSummary
      result.offlineFolders = offlineRoots.map((root) => root.path)
      if (snapshot && beganRun) {
        try {
          this.refreshPendingAudit(request.libraryId, auditState)
        } catch {
          // Preserve the original scan failure when pending state is also unavailable.
        }
        this.recordSummary(
          snapshot,
          runId,
          trigger,
          startedAt,
          'failed',
          result,
          errorSummary,
          auditState,
          []
        )
      }
      throw new Error(errorSummary)
    } finally {
      if (this.activeRun?.controller === controller) this.activeRun = null
      lease.release()
      if (beganRun) {
        this.emit(
          eventFailure
            ? {
                phase: 'failed',
                libraryId: request.libraryId,
                runId,
                trigger,
                error: eventFailure
              }
            : {
                phase: 'completed',
                libraryId: request.libraryId,
                runId,
                trigger,
                result
              }
        )
      }
    }
  }

  private selectRoots(
    snapshot: MediaLibraryScanSnapshot,
    requestedRootIds: number[] | undefined
  ): Readonly<MediaLibraryRoot>[] {
    if (!requestedRootIds?.length) return [...snapshot.roots]
    const rootIds = new Set(requestedRootIds)
    if (
      rootIds.size !== requestedRootIds.length ||
      requestedRootIds.some((rootId) => !Number.isSafeInteger(rootId) || rootId <= 0)
    ) {
      throw new Error('扫描根目录选择无效')
    }
    const selected = snapshot.roots.filter((root) => rootIds.has(root.id))
    if (selected.length !== rootIds.size) throw new Error('扫描根目录不属于该媒体库或已停用')
    return selected
  }

  private refreshPendingAudit(
    libraryId: number,
    auditState: Pick<LibraryScanAudit, 'files' | 'pendingGroups'>
  ): void {
    const auditPendingIds = new Set(
      auditState.files
        .filter(
          (entry): entry is Extract<LibraryScanFileAuditEntry, { outcome: 'pending' }> =>
            entry.outcome === 'pending' && entry.groupId != null
        )
        .map((entry) => entry.groupId as number)
    )
    auditState.pendingGroups = this.dependencies
      .listPendingScanGroups(libraryId)
      .filter((group) => auditPendingIds.has(group.id))
      .map((group): LibraryScanPendingGroupAuditEntry => ({
        groupId: group.id,
        normalizedCode: group.normalizedCode,
        resourceCount: group.resources.filter((resource) =>
          auditState.files.some(
            (entry) => entry.outcome === 'pending' && entry.filePath === resource.filePath
          )
        ).length
      }))
  }

  private emit(event: LibraryScanEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Failed to publish scan state:', sanitizeLibraryScanError(error))
      }
    }
  }

  private emptyResult(libraryId: number, runId: string): ScanResult {
    return {
      libraryId,
      runId,
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
      unrecognizedFiles: [],
      strmFailures: [],
      omittedStrmFailures: 0
    }
  }

  private cancelledResult(
    libraryId: number,
    runId: string,
    offlineRoots: readonly Readonly<MediaLibraryRoot>[]
  ): ScanResult {
    return {
      ...this.emptyResult(libraryId, runId),
      cancelled: true,
      offlineFolders: offlineRoots.map((root) => root.path)
    }
  }

  private recordSummary(
    snapshot: MediaLibraryScanSnapshot,
    runId: string,
    trigger: LibraryScanTrigger,
    startedAt: string,
    status: LibraryScanSummary['status'],
    result: ScanResult,
    errorSummary: string | null,
    auditState: Omit<
      LibraryScanAudit,
      | 'schemaVersion'
      | 'libraryId'
      | 'runId'
      | 'configRevision'
      | 'trigger'
      | 'startedAt'
      | 'finishedAt'
      | 'status'
    >,
    safeRoots: readonly Readonly<MediaLibraryRoot>[]
  ): void {
    const completedSafely = status === 'success' || status === 'completed_with_errors'
    if (completedSafely) {
      for (const root of safeRoots) {
        this.dependencies.authorizeRoot(snapshot.libraryId, root.id, root)
      }
    }
    const finishedAt = this.dependencies.now()
    const summary: LibraryScanSummary = {
      libraryId: snapshot.libraryId,
      runId,
      configRevision: snapshot.configRevision,
      trigger,
      startedAt,
      finishedAt,
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
      ...(result.strmFailures.length > 0 ? { strmFailures: [...result.strmFailures] } : {}),
      ...(result.strmFailures.length > 0 || result.omittedStrmFailures > 0
        ? { omittedStrmFailures: result.omittedStrmFailures }
        : {}),
      errorSummary
    }
    const audit: LibraryScanAudit = {
      schemaVersion: 1,
      libraryId: snapshot.libraryId,
      runId,
      configRevision: snapshot.configRevision,
      trigger,
      startedAt,
      finishedAt,
      status,
      ...auditState
    }
    const unrecognizedFiles: LibraryUnrecognizedFileInput[] = result.unrecognizedFiles.flatMap(
      (filePath) => {
        const root = safeRoots.find((candidate) => isPathUnderRoot(filePath, candidate.path))
        if (!root) return []
        this.dependencies.authorizeRootFile(snapshot.libraryId, root.id, filePath, root)
        return [
          {
            rootId: root.id,
            filePath,
            normalizedPath: normalizeLocalPathIdentity(filePath),
            reason: 'unrecognized_code'
          }
        ]
      }
    )
    this.dependencies.finishRun({
      libraryId: snapshot.libraryId,
      runId,
      status:
        status === 'success' || status === 'completed_with_errors'
          ? 'completed'
          : status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      summary,
      audit,
      ...(completedSafely
        ? {
            replaceUnrecognizedRootIds: safeRoots.map((root) => root.id),
            unrecognizedFiles
          }
        : {})
    })
  }

  private removeMissingAccessibleResources(
    libraryId: number,
    accessibleRoots: ReadonlyMap<number, Readonly<MediaLibraryRoot>>
  ): {
    removed: number
    promoted: number
    removedResources: LibraryScanResourceAuditEntry[]
    promotedResources: LibraryScanResourceAuditEntry[]
  } {
    let removed = 0
    let promoted = 0
    const removedResources: LibraryScanResourceAuditEntry[] = []
    const promotedResources: LibraryScanResourceAuditEntry[] = []
    for (const ref of this.dependencies.listLocalResources(libraryId)) {
      const resource = this.dependencies.getResourceById(libraryId, ref.resource_id)
      if (!resource?.root_id) continue
      const root = accessibleRoots.get(resource.root_id)
      if (!root) continue
      if (resource.kind !== 'local' && !resource.strm_source_path) continue
      const pathState = this.dependencies.inspectPath(ref.locator)
      if (pathState === 'present') continue
      if (pathState === 'unknown') {
        throw new Error(`无法确认本地资源是否存在：${ref.locator}`)
      }

      this.dependencies.authorizeRootDeletionTarget(
        libraryId,
        root.id,
        ref.locator,
        root
      )
      const remaining = this.dependencies
        .listResources(libraryId, ref.video_id)
        .filter((item) => item.id !== resource.id)
      const removedAudit = this.resourceAuditEntry(resource, 'missing')
      this.dependencies.removeResourceRecord(libraryId, resource.id)
      removed += 1
      if (removedAudit) removedResources.push(removedAudit)
      if (!resource.is_primary) continue
      const promotedResource = selectPrimaryVideoResourceCandidate(
        remaining,
        (locator) => this.dependencies.inspectPath(locator) === 'present'
      )
      if (!promotedResource) continue
      this.dependencies.setPrimaryResource(libraryId, ref.video_id, promotedResource.id)
      promoted += 1
      const promotedAudit = this.resourceAuditEntry(promotedResource, 'promoted_after_removal')
      if (promotedAudit) promotedResources.push(promotedAudit)
    }
    return { removed, promoted, removedResources, promotedResources }
  }

  private resourceAuditEntry(
    resource: VideoResource,
    reason: LibraryScanResourceAuditEntry['reason']
  ): LibraryScanResourceAuditEntry | null {
    const video = this.dependencies.getVideoById(resource.video_id)
    if (!video) return null
    return {
      resourceId: resource.id,
      videoId: video.id,
      videoCode: video.code,
      videoTitle: video.title,
      resourceKind: resource.kind,
      sourcePath: resource.kind === 'local' ? resource.locator : resource.strm_source_path,
      displayName: resource.display_name,
      reason
    }
  }
}

export function createScanCoordinator(
  dependencies: Partial<ScanCoordinatorDependencies> = {}
): ScanCoordinator {
  return new ScanCoordinator({
    readScanSnapshot: dependencies.readScanSnapshot ?? readMediaLibraryScanSnapshot,
    bindRootIdentities:
      dependencies.bindRootIdentities ?? bindOnlineMediaLibraryRootIdentities,
    inspectRoot: dependencies.inspectRoot ?? inspectStableRoot,
    authorizeRoot: dependencies.authorizeRoot ?? authorizeMediaLibraryRoot,
    authorizeRootFile: dependencies.authorizeRootFile ?? authorizeMediaLibraryRootFile,
    authorizeRootDeletionTarget:
      dependencies.authorizeRootDeletionTarget ?? authorizeMediaLibraryRootDeletionTarget,
    scanFolders: dependencies.scanFolders ?? scanFolders,
    listLocalResources: dependencies.listLocalResources ?? listSourceManagedVideoResourceRefs,
    getResourceById: dependencies.getResourceById ?? getVideoResourceInLibrary,
    getVideoById: dependencies.getVideoById ?? getVideoById,
    listResources: dependencies.listResources ?? listVideoResources,
    removeResourceRecord: dependencies.removeResourceRecord ?? removeVideoResourceRecord,
    setPrimaryResource: dependencies.setPrimaryResource ?? setPrimaryVideoResource,
    inspectPath: dependencies.inspectPath ?? inspectLocalPath,
    reconcilePendingScanResources:
      dependencies.reconcilePendingScanResources ?? reconcilePendingScanResources,
    recoverPendingPathCleanups:
      dependencies.recoverPendingPathCleanups ?? recoverLegacyLibraryPathCleanups,
    listPendingPathCleanups:
      dependencies.listPendingPathCleanups ?? listPendingLibraryPathCleanupRoots,
    applyPendingPathCleanups:
      dependencies.applyPendingPathCleanups ?? applyPendingLibraryPathCleanups,
    runCleanupTransaction: dependencies.runCleanupTransaction ?? runCleanupTransaction,
    removeResourceLessMemberships:
      dependencies.removeResourceLessMemberships ?? removeResourceLessMemberships,
    listPendingScanGroups: dependencies.listPendingScanGroups ?? listPendingScanGroups,
    beginRun: dependencies.beginRun ?? beginLibraryScanRun,
    finishRun: dependencies.finishRun ?? finishLibraryScanRun,
    now: dependencies.now ?? (() => new Date().toISOString()),
    createRunId: dependencies.createRunId ?? randomUUID,
    gate: dependencies.gate ?? maintenanceTaskGate
  })
}

export const scanCoordinator = createScanCoordinator()
