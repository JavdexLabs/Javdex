import fs from 'node:fs'
import { createScanCleanupPages } from './scanCleanupPages'
import { createProgressPublisher } from '../services/progressPublisher'
import { randomUUID } from 'node:crypto'
import type {
  LibraryScanAudit,
  LibraryScanEvent,
  LibraryScanDeletedVideoAuditEntry,
  LibraryScanResourceAuditEntry,
  LibraryScanSummary,
  LibraryScanTrigger,
  PendingLibraryPathCleanup,
  ScanProgress,
  ScanCompletionResult,
  ScanExecutionResult
} from '@shared/libraryTypes'
import { getUnrecognizedFileCount, toScanCompletionResult } from '@shared/scanResult'
import { LEGACY_CLEANUP_WAITING_ERROR } from '@shared/legacyLibraryCleanup'
import { sanitizeLibraryScanError } from '@shared/libraryScanSummary'
import { normalizeLocalPathIdentity } from '@library/localPathIdentity'
import type { MediaLibraryRoot, MediaLibraryScanSnapshot } from '@shared/mediaLibraryTypes'
import type { Video, VideoResource } from '@shared/videoTypes'
import {
  getVideoById,
  getVideoResourceInLibrary,
  iterateSourceManagedVideoResourceRefs,
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
  removeResourceLessMembershipPage,
  removeResourceLessMembershipsWithAudit,
  type RemovedResourceLessMembership
} from '../db/libraryMembershipRepo'
import {
  beginLibraryScanRun,
  finishLibraryScanRun,
  finishLibraryScanEntriesRun,
  type LibraryUnrecognizedFileInput
} from '../db/libraryScanRepo'
import { reconcilePendingScanResources } from '../db/pendingScanRepo'
import { createScanAuditWriter } from '../db/scanAuditWriter'
import { iterateScanAuditUnrecognizedPaths } from '../db/scanAuditUnrecognizedPaths'
import { readPendingScanAuditEntries } from '../db/pendingScanAuditRepo'
import { reconcilePendingResourceIdentities } from '../db/pendingResourceIdentityRepo'
import { maintenanceTaskGate, type MaintenanceTaskGate } from '../services/maintenanceTaskGate'
import {
  authorizeMediaLibraryRoot,
  authorizeMediaLibraryRootDeletionTarget,
  authorizeMediaLibraryRootFile
} from '../services/mediaLibraryRootFileGuard'
import { selectPrimaryVideoResourceCandidate } from '../services/videoResourcePromotion'
import {
  applyPendingLibraryPathCleanups,
  createPendingLibraryPathCleanupPages,
  listPendingLibraryPathCleanupRoots,
  recoverLegacyLibraryPathCleanups,
  type RecoverLegacyLibraryPathCleanupResult,
  type LibraryPathCleanupAuditEvent
} from '../services/libraryPathCleanupService'
import { createLibraryRootMatcher } from './libraryRootMatcher'
import {
  scanFolders,
  ScanFoldersFailure,
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

export type ScanCleanupAuditEvent = LibraryPathCleanupAuditEvent | {
  section: 'deletedVideos'
  entry: LibraryScanDeletedVideoAuditEntry
}

export interface ScanCoordinatorDependencies {
  /** Explicit legacy compatibility for injected fixtures; production defaults to entries. */
  auditStorage?: 'json' | 'entries'
  /** Explicit synchronous compatibility oracle. Entries production uses cooperative pages. */
  cleanupMode?: 'atomic' | 'cooperative'
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
  ) => Promise<ScanExecutionResult>
  listLocalResources: (libraryId: number) => Iterable<LocalVideoResourceRef>
  getResourceById: (libraryId: number, resourceId: number) => VideoResource | null
  getVideoById: (videoId: number) => Video | null
  listResources: (libraryId: number, videoId: number) => VideoResource[]
  removeResourceRecord: (libraryId: number, resourceId: number) => void
  setPrimaryResource: (libraryId: number, videoId: number, resourceId: number) => void
  inspectPath: (filePath: string) => LocalPathState
  reconcilePendingScanResources: typeof reconcilePendingScanResources
  reconcilePendingResourceIdentities: typeof reconcilePendingResourceIdentities
  recoverPendingPathCleanups: (libraryId: number) => RecoverLegacyLibraryPathCleanupResult
  listPendingPathCleanups: (libraryId: number) => PendingLibraryPathCleanup[]
  applyPendingPathCleanups: typeof applyPendingLibraryPathCleanups
  /** Synchronous, inside the cleanup transaction; durable sinks must use its database connection. */
  recordCleanupAudit?: (
    identity: { libraryId: number; runId: string },
    event: ScanCleanupAuditEvent
  ) => void
  runCleanupTransaction: <T>(operation: () => T) => T
  /** Atomic compatibility path only; cooperative cleanup uses the page dependency below. */
  removeResourceLessMemberships: (libraryId: number) => RemovedResourceLessMembership[]
  /** Atomic compatibility path with a synchronous audit sink. */
  removeResourceLessMembershipsWithAudit: (
    libraryId: number,
    onRemoved: Parameters<typeof removeResourceLessMembershipsWithAudit>[1]
  ) => number
  /** Cooperative path; called synchronously inside the business/audit page transaction. */
  removeResourceLessMembershipPage: typeof removeResourceLessMembershipPage
  readPendingScanAuditEntries: typeof readPendingScanAuditEntries
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
  private stopping = false
  private readonly pendingRuns = new Set<Promise<ScanCompletionResult>>()
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

  run(request: ScanCoordinatorRequest): Promise<ScanCompletionResult> {
    if (this.stopping) return Promise.reject(new Error('扫描协调器正在关闭'))
    const task = this.runInternal(request)
    this.pendingRuns.add(task)
    void task.then(() => this.pendingRuns.delete(task), () => this.pendingRuns.delete(task))
    return task
  }

  /** Stop admission immediately; cancellation drains the current committed unit before DB close. */
  async stopAndDrain(): Promise<void> {
    this.stopping = true
    this.cancel()
    await Promise.allSettled([...this.pendingRuns])
  }

  private async runInternal(request: ScanCoordinatorRequest): Promise<ScanCompletionResult> {
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
    const useEntries = this.dependencies.auditStorage !== 'json'
    let result = this.emptyResult(request.libraryId, runId, useEntries)
    const offlineRoots: Readonly<MediaLibraryRoot>[] = []
    let eventFailure: string | null = null
    let snapshot: MediaLibraryScanSnapshot | null = null
    let selectedRoots: Readonly<MediaLibraryRoot>[] = []
    let beganRun = false
    let writer: ReturnType<typeof createScanAuditWriter> | undefined
    let storageFailed = false
    let finalizationFailed = false
    const persist = <T>(operation: () => T): T => {
      try { return operation() } catch (error) { storageFailed = true; throw error }
    }
    const progressPublisher = createProgressPublisher<ScanProgress>((progress) => {
      this.emit({ phase: 'progress', libraryId: request.libraryId, runId, trigger, progress })
    })
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

    const finish = (status: LibraryScanSummary['status'], error: string | null,
      safeRoots: readonly Readonly<MediaLibraryRoot>[]): void => {
      try {
        this.recordSummary(snapshot!, runId, trigger, startedAt, status, result, error, auditState, safeRoots, writer)
      } catch (failure) {
        finalizationFailed = true
        throw failure
      }
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
      const begin = (): void => {
        this.dependencies.beginRun({
          libraryId: request.libraryId, runId, configRevision: snapshot!.configRevision, trigger, startedAt
        })
        if (useEntries) {
          writer = createScanAuditWriter(getDb(), { libraryId: request.libraryId, runId })
          persist(() => writer!.start({
            schemaVersion: 2, libraryId: request.libraryId, runId,
            configRevision: snapshot!.configRevision, trigger, startedAt, finishedAt: startedAt, status: 'success'
          }))
        }
      }
      if (useEntries) getDb().transaction(begin)()
      else begin()
      beganRun = true
      this.emit({ phase: 'started', libraryId: request.libraryId, runId, trigger })
      if (hasNoRunnableWork) throw new Error(LEGACY_CLEANUP_WAITING_ERROR)

      const accessibleRoots: Readonly<MediaLibraryRoot>[] = []
      for (const root of selectedRoots) {
        if (controller.signal.aborted) {
          result = this.cancelledResult(request.libraryId, runId, offlineRoots, useEntries)
          finish('cancelled', null, [])
          return toScanCompletionResult(result)
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
          progressPublisher.update(progress)
        },
        {
          signal: controller.signal,
          unavailableRootIds: offlineRoots.map((root) => root.id),
          minImportDurationSeconds: resolveMinScanImportDurationSeconds(
            snapshot.config.minImportDurationMinutes
          ),
          autoMergeSameCodeResources: snapshot.config.autoMergeSameCodeResources,
          autoImportLocalNfo: snapshot.config.autoImportLocalNfo,
          ...(writer ? { resultMode: 'summary', auditSink: {
            recordFile: (entry) => persist(() => writer!.writeBatch('files', [entry])),
            readFileNfo: (filePath) => persist(() => writer!.readFileNfo(filePath)),
            patchNfo: (filePath, nfo) => persist(() => writer!.patchNfo(filePath, nfo))
          } satisfies NonNullable<ScanOptions['auditSink']> } : {
            resultMode: 'detailed',
            onFileResult: (entry: LibraryScanAudit['files'][number]) => { auditState.files.push(entry) }
          })
        }
      )

      const safeRoots: Readonly<MediaLibraryRoot>[] = []
      for (const root of accessibleRoots) {
        if (await this.dependencies.inspectRoot(root)) safeRoots.push(root)
        else if (!offlineRoots.some((offline) => offline.id === root.id)) offlineRoots.push(root)
      }
      result.offlineFolders = offlineRoots.map((root) => root.path)
      if (!writer) this.refreshPendingAudit(request.libraryId, auditState)
      if (controller.signal.aborted || result.cancelled) {
        result.cancelled = true
        finish('cancelled', null, [])
        return toScanCompletionResult(result)
      }

      const processingFailures = Math.max(
        0,
        result.failed -
          getUnrecognizedFileCount(result) -
          result.strmFailures.length -
          result.omittedStrmFailures
      )
      if (processingFailures > 0) {
        eventFailure = `有 ${processingFailures} 个文件处理失败，已跳过资源清理`
        finish('failed', eventFailure, [])
        return toScanCompletionResult(result)
      }

      const isFullScan =
        !request.rootIds?.length &&
        selectedRoots.length === snapshot.roots.length &&
        selectedRoots.every((root) => snapshot?.roots.some((item) => item.id === root.id))
      const safeRootIds = new Set(safeRoots.map((root) => root.id))
      const safeRootsById = new Map(safeRoots.map((root) => [root.id, root] as const))
      const matchPendingRoot = createLibraryRootMatcher(safeRoots, true)
      const recordCleanupAudit = (event: ScanCleanupAuditEvent): void => {
        if (writer) persist(() => {
          if (event.section === 'deletedVideos') writer!.writeBatch('deletedVideos', [event.entry])
          else writer!.writeBatch(event.section, [event.entry])
        })
        const returned: unknown = this.dependencies.recordCleanupAudit?.(
          { libraryId: request.libraryId, runId }, event
        )
        if (returned != null && (typeof returned === 'object' || typeof returned === 'function') &&
            typeof (returned as { then?: unknown }).then === 'function') {
          void Promise.resolve(returned).catch(() => {})
          throw new Error('Cleanup audit callback must be synchronous')
        }
      }
      if (this.dependencies.cleanupMode === 'cooperative') {
        const pages = createScanCleanupPages(getDb(), request.libraryId)
        let cleanupFailure = false
        let cleanupError: unknown
        try {
          const authorize = () => {
            for (const root of safeRoots) this.dependencies.authorizeRoot(request.libraryId, root.id, root)
          }
          const inspect = (filePath: string): LocalPathState => {
            const root = matchPendingRoot(filePath)
            if (!root) return 'unknown'
            const state = this.dependencies.inspectPath(filePath)
            if (state === 'present') this.dependencies.authorizeRootFile(request.libraryId, root.id, filePath, root)
            else if (state === 'missing') this.dependencies.authorizeRootDeletionTarget(request.libraryId, root.id, filePath, root)
            else this.dependencies.authorizeRoot(request.libraryId, root.id, root)
            return state
          }
          const transaction = this.dependencies.runCleanupTransaction
          const noop = () => {}
          await pages.each('pendingScan', controller.signal, transaction, ids => {
            authorize()
            this.dependencies.reconcilePendingScanResources(request.libraryId, [...safeRootIds], inspect, ids)
          }, noop)
          await pages.each('pendingIdentity', controller.signal, transaction, ids => {
            authorize()
            this.dependencies.reconcilePendingResourceIdentities(request.libraryId, [...safeRootIds], inspect, ids)
          }, noop)
          await pages.each('resources', controller.signal, transaction, ids => {
            authorize()
            const refs: LocalVideoResourceRef[] = []
            for (const id of ids) {
              const resource = this.dependencies.getResourceById(request.libraryId, id)
              if (resource && (resource.kind === 'local' || resource.strm_source_path)) refs.push({
                library_id: request.libraryId, resource_id: id, video_id: resource.video_id,
                locator: resource.kind === 'local' ? resource.locator : resource.strm_source_path!
              })
            }
            return this.removeMissingAccessibleResources(request.libraryId, safeRootsById, recordCleanupAudit, false, refs)
          }, value => { result.removed += value.removed; result.promoted += value.promoted })
          if (!controller.signal.aborted && isFullScan && pendingPathCleanups.length) {
            const deferred = createPendingLibraryPathCleanupPages(pendingPathCleanups, pages.resourceHighWater)
            await pages.each('resources', controller.signal, transaction,
              ids => deferred.resources(ids, recordCleanupAudit),
              value => { result.removed += value.removed; result.promoted += value.promoted })
            for (const kind of ['pendingScan', 'pendingIdentity', 'unrecognized'] as const) {
              await pages.each(kind, controller.signal, transaction, ids => deferred.pending(kind, ids), noop)
            }
            await pages.each('pendingGroups', controller.signal, transaction, ids => deferred.emptyGroups(ids), noop)
            if (!controller.signal.aborted) transaction(() => deferred.finish())
          }
          if (isFullScan && offlineRoots.length === 0 && snapshot.config.removeResourceLessMemberships) {
            await pages.each('memberships', controller.signal, transaction, ids => {
              authorize()
              return this.dependencies.removeResourceLessMembershipPage(request.libraryId, ids, video => recordCleanupAudit({
                section: 'deletedVideos', entry: { ...video, reason: 'resource_less' }
              }))
            }, count => { result.deletedVideos += count })
          }
        } catch (error) { cleanupFailure = true; cleanupError = error }
        finally {
          try { pages.dispose() } catch (error) {
            if (!cleanupFailure) { cleanupFailure = true; cleanupError = error }
          }
        }
        if (cleanupFailure) throw cleanupError
        if (controller.signal.aborted) {
          result.cancelled = true
          finish('cancelled', null, [])
          return toScanCompletionResult(result)
        }
      } else {
      const cleanup = this.dependencies.runCleanupTransaction(() => {
        for (const root of safeRoots) {
          this.dependencies.authorizeRoot(request.libraryId, root.id, root)
        }
        const inspectAuthorizedPendingPath = (filePath: string): LocalPathState => {
          const root = matchPendingRoot(filePath)
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
        this.dependencies.reconcilePendingResourceIdentities(
          request.libraryId,
          [...safeRootIds],
          inspectAuthorizedPendingPath
        )
        const missingResources = this.removeMissingAccessibleResources(
          request.libraryId,
          safeRootsById,
          recordCleanupAudit,
          !writer
        )
        const deferredRemoved: LibraryScanResourceAuditEntry[] = []
        const deferredPromoted: LibraryScanResourceAuditEntry[] = []
        const deferredCleanup =
          isFullScan && pendingPathCleanups.length > 0
            ? this.dependencies.applyPendingPathCleanups(pendingPathCleanups, (event) => {
                recordCleanupAudit(event)
                if (!writer) {
                  if (event.section === 'removedResources') deferredRemoved.push(event.entry)
                  else deferredPromoted.push(event.entry)
                }
              })
            : { removed: 0, promoted: 0, consumedRoots: [] }
        const recordRemovedMembership = (video: RemovedResourceLessMembership): void => {
          recordCleanupAudit({ section: 'deletedVideos', entry: {
            videoId: video.videoId, videoCode: video.videoCode,
            videoTitle: video.videoTitle, reason: 'resource_less'
          } })
        }
        let removedMemberships: RemovedResourceLessMembership[] = []
        let removedMembershipCount = 0
        if (isFullScan && offlineRoots.length === 0 && snapshot?.config.removeResourceLessMemberships) {
          if (writer) {
            removedMembershipCount = this.dependencies.removeResourceLessMembershipsWithAudit(
              request.libraryId, recordRemovedMembership
            )
          } else {
            removedMemberships = this.dependencies.removeResourceLessMemberships(request.libraryId)
            for (const video of removedMemberships) recordRemovedMembership(video)
            removedMembershipCount = removedMemberships.length
          }
        }
        return { missingResources, deferredCleanup, removedMemberships, removedMembershipCount, deferredRemoved, deferredPromoted }
      })
      result.removed += cleanup.missingResources.removed + cleanup.deferredCleanup.removed
      result.promoted += cleanup.missingResources.promoted + cleanup.deferredCleanup.promoted
      result.deletedVideos = cleanup.removedMembershipCount
      for (const resource of cleanup.missingResources.removedResources) {
        auditState.removedResources.push(resource)
      }
      for (const resource of cleanup.missingResources.promotedResources) {
        auditState.promotedResources.push(resource)
      }
      for (const resource of cleanup.deferredRemoved) auditState.removedResources.push(resource)
      for (const resource of cleanup.deferredPromoted) auditState.promotedResources.push(resource)
      if (!writer) for (const video of cleanup.removedMemberships) {
        auditState.deletedVideos.push({
          videoId: video.videoId,
          videoCode: video.videoCode,
          videoTitle: video.videoTitle,
          reason: 'resource_less'
        })
      }
      }
      const status =
        result.strmFailures.length + result.omittedStrmFailures > 0
          ? 'completed_with_errors'
          : 'success'
      finish(status, null, safeRoots)
      return toScanCompletionResult(result)
    } catch (error) {
      if (error instanceof ScanFoldersFailure && error.partialResult.libraryId === request.libraryId &&
          error.partialResult.runId === runId) {
        result = error.partialResult
      }
      const errorSummary = sanitizeLibraryScanError(error)
      eventFailure = errorSummary
      result.offlineFolders = offlineRoots.map((root) => root.path)
      if (snapshot && beganRun) {
        // Storage marks a rolled-back operation, not persistent unavailability.
        // Finalization wins when both flags are set; never repeat that attempt.
        const failurePhase = finalizationFailed ? 'finalization' : storageFailed ? 'storage' : 'scan'
        if (writer && failurePhase === 'finalization') {
          try { this.failUnpublishedRun(request.libraryId, runId, errorSummary) } catch {
            // Startup recovery handles unavailable storage; keep the original failure.
          }
        } else {
          try {
            // File/NFO business and audit writes roll back together. Publish the
            // remaining committed entries with partial counts when storage permits.
            if (!writer) this.refreshPendingAudit(request.libraryId, auditState)
            finish('failed', errorSummary, [])
          } catch {
            if (writer) {
              try { this.failUnpublishedRun(request.libraryId, runId, errorSummary) } catch {
                // Never replace the triggering error with a secondary finalization error.
              }
            }
          }
        }
      }
      throw new Error(errorSummary)
    } finally {
      progressPublisher.close()
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
                result: toScanCompletionResult(result)
              }
        )
      }
    }
  }

  /** Keep incomplete audit staging hidden; startup recovery will abandon it. */
  private failUnpublishedRun(libraryId: number, runId: string, error: string): void {
    const database = getDb(), finishedAt = this.dependencies.now()
    database.transaction(() => {
      const changed = database.prepare(`UPDATE library_scan_runs SET status='failed',finished_at=?,error_summary=?
        WHERE id=? AND library_id=? AND status='running' AND NOT EXISTS (
          SELECT 1 FROM library_scan_audit_manifests WHERE run_id=? AND state='published'
        )`).run(finishedAt, error, runId, libraryId, runId)
      if (changed.changes === 0) return
      database.prepare(`UPDATE media_library_scan_state SET active_run_id=NULL,last_status='failed',
        last_finished_at=?,last_error=?,revision=revision+1 WHERE library_id=? AND active_run_id=?`)
        .run(finishedAt, error, libraryId, runId)
    })()
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
    const groupIds = new Set<number>()
    const pendingPaths = new Set<string>()
    for (const entry of auditState.files) {
      if (entry.outcome !== 'pending') continue
      pendingPaths.add(entry.filePath)
      if (entry.groupId != null) groupIds.add(entry.groupId)
    }
    auditState.pendingGroups = groupIds.size === 0
      ? []
      : this.dependencies.readPendingScanAuditEntries(libraryId, groupIds, pendingPaths)
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

  private emptyResult(libraryId: number, runId: string, summary: boolean): ScanExecutionResult {
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
      ...(summary ? { unrecognizedCount: 0 } : { newCodes: [], unrecognizedFiles: [] }),
      strmFailures: [],
      omittedStrmFailures: 0
    }
  }

  private cancelledResult(
    libraryId: number,
    runId: string,
    offlineRoots: readonly Readonly<MediaLibraryRoot>[],
    summary: boolean
  ): ScanExecutionResult {
    return {
      ...this.emptyResult(libraryId, runId, summary),
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
    result: ScanExecutionResult,
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
    safeRoots: readonly Readonly<MediaLibraryRoot>[],
    writer?: ReturnType<typeof createScanAuditWriter>
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
    if (writer) {
      const database = getDb()
      const matchUnrecognizedRoot = createLibraryRootMatcher(safeRoots)
      const authorize = this.dependencies.authorizeRootFile
      // A fresh generator for this attempt; finish does not consume it for failed
      // or cancelled runs. Each source query completes before authorization/write.
      function* unrecognizedFiles(): Generator<LibraryUnrecognizedFileInput> {
        for (const filePath of iterateScanAuditUnrecognizedPaths(database, { libraryId: snapshot.libraryId, runId })) {
          const root = matchUnrecognizedRoot(filePath)
          if (!root) continue
          authorize(snapshot.libraryId, root.id, filePath, root)
          yield { rootId: root.id, filePath, normalizedPath: normalizeLocalPathIdentity(filePath), reason: 'unrecognized_code' }
        }
      }
      database.transaction(() => {
        writer.refreshPendingGroups()
        writer.seal({ schemaVersion: 2, libraryId: snapshot.libraryId, runId,
          configRevision: snapshot.configRevision, trigger, startedAt, finishedAt, status })
        finishLibraryScanEntriesRun({
          libraryId: snapshot.libraryId, runId,
          status: completedSafely ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed',
          summary,
          ...(completedSafely ? { replaceUnrecognizedRootIds: safeRoots.map((root) => root.id),
            unrecognizedFiles: unrecognizedFiles() } : {})
        })
      })()
      return
    }
    if (!('unrecognizedFiles' in result)) {
      throw new Error('Legacy JSON audit requires detailed scan results')
    }
    const audit: LibraryScanAudit = {
      schemaVersion: 2,
      libraryId: snapshot.libraryId,
      runId,
      configRevision: snapshot.configRevision,
      trigger,
      startedAt,
      finishedAt,
      status,
      ...auditState
    }
    const matchUnrecognizedRoot = createLibraryRootMatcher(safeRoots)
    const unrecognizedFiles: LibraryUnrecognizedFileInput[] = result.unrecognizedFiles.flatMap(
      (filePath) => {
        const root = matchUnrecognizedRoot(filePath)
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
    accessibleRoots: ReadonlyMap<number, Readonly<MediaLibraryRoot>>,
    recordAudit: (event: LibraryPathCleanupAuditEvent) => void,
    collectEntries = true,
    candidates?: Iterable<LocalVideoResourceRef>
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
    for (const ref of candidates ?? this.dependencies.listLocalResources(libraryId)) {
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
      const remaining = resource.is_primary
        ? this.dependencies.listResources(libraryId, ref.video_id)
          .filter((item) => item.id !== resource.id)
        : []
      const removedAudit = this.resourceAuditEntry(resource, 'missing')
      if (!removedAudit && (!collectEntries || this.dependencies.recordCleanupAudit)) {
        throw new Error('Cannot record cleanup audit for a missing video')
      }
      this.dependencies.removeResourceRecord(libraryId, resource.id)
      if ((!collectEntries || this.dependencies.recordCleanupAudit) && this.dependencies.getResourceById(libraryId, resource.id)) {
        throw new Error('Cleanup resource deletion did not take effect')
      }
      removed += 1
      if (removedAudit) {
        recordAudit({ section: 'removedResources', entry: removedAudit })
        if (collectEntries) removedResources.push(removedAudit)
      }
      if (!resource.is_primary) continue
      const promotedResource = selectPrimaryVideoResourceCandidate(
        remaining,
        (locator) => this.dependencies.inspectPath(locator) === 'present'
      )
      if (!promotedResource) continue
      this.dependencies.setPrimaryResource(libraryId, ref.video_id, promotedResource.id)
      if (!collectEntries || this.dependencies.recordCleanupAudit) {
        const current = this.dependencies.getResourceById(libraryId, promotedResource.id)
        if (!current || current.video_id !== ref.video_id || current.is_primary !== 1) {
          throw new Error('Cleanup primary resource promotion did not take effect')
        }
      }
      promoted += 1
      const promotedAudit = this.resourceAuditEntry(promotedResource, 'promoted_after_removal')
      if (!promotedAudit && (!collectEntries || this.dependencies.recordCleanupAudit)) {
        throw new Error('Cannot record promotion audit for a missing video')
      }
      if (promotedAudit) {
        recordAudit({ section: 'promotedResources', entry: promotedAudit })
        if (collectEntries) promotedResources.push(promotedAudit)
      }
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
    auditStorage: dependencies.auditStorage ?? 'entries',
    cleanupMode: dependencies.cleanupMode ?? (dependencies.auditStorage === 'json' ? 'atomic' : 'cooperative'),
    readScanSnapshot: dependencies.readScanSnapshot ?? readMediaLibraryScanSnapshot,
    bindRootIdentities:
      dependencies.bindRootIdentities ?? bindOnlineMediaLibraryRootIdentities,
    inspectRoot: dependencies.inspectRoot ?? inspectStableRoot,
    authorizeRoot: dependencies.authorizeRoot ?? authorizeMediaLibraryRoot,
    authorizeRootFile: dependencies.authorizeRootFile ?? authorizeMediaLibraryRootFile,
    authorizeRootDeletionTarget:
      dependencies.authorizeRootDeletionTarget ?? authorizeMediaLibraryRootDeletionTarget,
    scanFolders: dependencies.scanFolders ?? scanFolders,
    listLocalResources: dependencies.listLocalResources ?? iterateSourceManagedVideoResourceRefs,
    getResourceById: dependencies.getResourceById ?? getVideoResourceInLibrary,
    getVideoById: dependencies.getVideoById ?? getVideoById,
    listResources: dependencies.listResources ?? listVideoResources,
    removeResourceRecord: dependencies.removeResourceRecord ?? removeVideoResourceRecord,
    setPrimaryResource: dependencies.setPrimaryResource ?? setPrimaryVideoResource,
    inspectPath: dependencies.inspectPath ?? inspectLocalPath,
    reconcilePendingScanResources:
      dependencies.reconcilePendingScanResources ?? reconcilePendingScanResources,
    reconcilePendingResourceIdentities:
      dependencies.reconcilePendingResourceIdentities ?? reconcilePendingResourceIdentities,
    recoverPendingPathCleanups:
      dependencies.recoverPendingPathCleanups ?? recoverLegacyLibraryPathCleanups,
    listPendingPathCleanups:
      dependencies.listPendingPathCleanups ?? listPendingLibraryPathCleanupRoots,
    applyPendingPathCleanups:
      dependencies.applyPendingPathCleanups ?? applyPendingLibraryPathCleanups,
    recordCleanupAudit: dependencies.recordCleanupAudit,
    runCleanupTransaction: dependencies.runCleanupTransaction ?? runCleanupTransaction,
    removeResourceLessMemberships:
      dependencies.removeResourceLessMemberships ?? removeResourceLessMemberships,
    removeResourceLessMembershipsWithAudit:
      dependencies.removeResourceLessMembershipsWithAudit ?? removeResourceLessMembershipsWithAudit,
    removeResourceLessMembershipPage:
      dependencies.removeResourceLessMembershipPage ?? removeResourceLessMembershipPage,
    readPendingScanAuditEntries: dependencies.readPendingScanAuditEntries ?? readPendingScanAuditEntries,
    beginRun: dependencies.beginRun ?? beginLibraryScanRun,
    finishRun: dependencies.finishRun ?? finishLibraryScanRun,
    now: dependencies.now ?? (() => new Date().toISOString()),
    createRunId: dependencies.createRunId ?? randomUUID,
    gate: dependencies.gate ?? maintenanceTaskGate
  })
}

export const scanCoordinator = createScanCoordinator()
