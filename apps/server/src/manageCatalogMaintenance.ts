import fs from 'node:fs'
import { structuredError } from '@shared/protocol/errors'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { ManageOperationId } from '@shared/manage/operations'
import type { NfoExportPlanRequest, NfoExportPreferences } from '@shared/nfoExportTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import type { ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import { getMediaLibraryDetail, MediaLibraryRepoError } from '@library/db/mediaLibraryRepo'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'
import { acceptCatalogTask } from '@library/catalog/catalogOperations'
import { handoffWaitingBlocksNewMaintenance } from '@library/catalog/catalogWriter'
import { listCatalogTasks, readCatalogTask } from '@library/catalog/catalogTasks'
import {
  catalogScanAuditGet,
  catalogScanAuditHeader,
  catalogScanAuditPage,
  catalogScanAuditViewPage,
  catalogScanLatest
} from '@library/catalog/catalogAuditRead'
import {
  importCatalogManualFile,
  previewRenameCatalogFile,
  renameCatalogFile
} from '@library/catalog/catalogFileMaintenance'
import {
  enqueueLibraryScan,
  requestLibraryScanCancel,
  startLibraryScan
} from '@library/catalog/catalogScanRuntime'
import {
  discardCatalogNfoPlan,
  enqueueCatalogNfoExport,
  getCatalogNfoOptions,
  peekCatalogNfoPlanDigest,
  planCatalogNfoExport,
  catalogNfoState,
  startCatalogNfoExportTask,
  terminateCatalogNfoExport,
  updateCatalogNfoPreferences
} from '@library/catalog/catalogNfoExport'
import {
  confirmLibraryPathRemoval,
  previewLibraryPathRemoval
} from '@library/scan/libraryPathCleanupService'
import {
  initializeJavdexRootMarker,
  markJavdexRootInitialized
} from '@library/scan/javdexRootMarker'
import { resolveMountSelectionPath } from '@library/scan/mountSelection'
import {
  commit,
  requireLibraryRevision,
  requireMutation,
  type CatalogHandler,
  type HandlerArgs
} from './manageCatalogHandlers'

const mediaLibraries = createMediaLibraryService(
  createMediaLibraryServiceDependencies({
    isVideoScraperRunnable: () => true
  })
)

function mapMaintenanceError(error: unknown): never {
  if (error instanceof MediaLibraryRepoError) {
    if (error.code === 'REVISION_CONFLICT') {
      throw structuredError('VERSION_CONFLICT', error.message)
    }
    if (error.code === 'LIBRARY_BUSY') {
      throw structuredError('MAINTENANCE_BUSY', error.message)
    }
    throw structuredError('INVALID_INPUT', error.message)
  }
  if (error instanceof Error && /已有扫描或资源维护/.test(error.message)) {
    throw structuredError('MAINTENANCE_BUSY', error.message)
  }
  throw error
}

function runMaintenance<T>(work: () => T): T {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
  try {
    return work()
  } catch (error) {
    return mapMaintenanceError(error)
  }
}

/** Test-only: if `JAVDEX_TEST_STALL_TASKS_GET` names an existing file, consume it and delay. */
function stallCatalogTaskGetForTests(): Promise<void> | null {
  const stallPath = process.env.JAVDEX_TEST_STALL_TASKS_GET
  if (!stallPath) return null
  try {
    fs.unlinkSync(stallPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  fs.writeFileSync(`${stallPath}.started`, '1')
  const delayMs = Number(process.env.JAVDEX_TEST_STALL_TASKS_GET_MS ?? 8_000)
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 8_000))
}

function requireVersionField(
  expected: ExpectedVersions,
  scope: 'C' | 'G' | 'R' | 'V',
  operationId: string
): void {
  if (!expected[scope]) {
    throw structuredError(
      'INVALID_INPUT',
      `需要 ${scope} 版本`,
      { field: `expectedVersions.${scope}` },
      operationId
    )
  }
}

function requireRootGeneration(expected: ExpectedVersions, operationId: string): void {
  requireVersionField(expected, 'G', operationId)
}

function requireLibraryExists(libraryId: number) {
  const library = getMediaLibraryDetail(libraryId)
  if (!library) throw structuredError('INVALID_INPUT', '媒体库不存在')
  return library
}

function acceptTask<T extends { taskId: string }>(args: HandlerArgs, enqueue: () => T): unknown {
  const mutation = requireMutation(args.envelope)
  const result = acceptCatalogTask(
    {
      operationId: mutation.operationId,
      operation: args.operation,
      expectedVersions: mutation.expectedVersions,
      input: args.envelope.input,
      writerEpoch: args.auth.epoch
    },
    enqueue,
    args.database
  )
  return { receipt: result.receipt, ...result.data, outcome: result.outcome }
}

function assertLibraryConfigVersions(
  libraryId: number,
  expected: ExpectedVersions,
  operationId: string
): void {
  const library = requireLibraryExists(libraryId)
  const expectedL = requireLibraryRevision(expected, 'L', operationId)
  const expectedC = requireLibraryRevision(expected, 'C', operationId)
  if (expectedL !== library.revision || expectedC !== library.config.revision) {
    throw structuredError('VERSION_CONFLICT', '媒体库或配置版本已变化，请刷新后重试', undefined, operationId)
  }
  requireRootGeneration(expected, operationId)
}

export const maintenanceHandlers: Partial<Record<ManageOperationId, CatalogHandler>> = {
  'libraries.addRoot'(args) {
    const input = args.envelope.input as {
      libraryId: number
      root: { mountSelectionId: string; position?: number; state?: 'active' | 'pending_removal' | 'disabled' }
    }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    return commit(args, () =>
      runMaintenance(() => {
        const mountPath = resolveMountSelectionPath(input.root.mountSelectionId)
        initializeJavdexRootMarker(mountPath)
        const root = mediaLibraries.addRoot({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
          root: {
            path: mountPath,
            position: input.root.position,
            state: input.root.state
          }
        })
        markJavdexRootInitialized(input.libraryId, root.id)
        return root
      })
    )
  },
  'libraries.updateRoot'(args) {
    const input = args.envelope.input as {
      libraryId: number
      rootId: number
      position?: number
      state?: 'active' | 'pending_removal' | 'disabled'
    }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    return commit(args, () =>
      runMaintenance(() =>
        mediaLibraries.updateRoot({
          libraryId: input.libraryId,
          rootId: input.rootId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
          patch: {
            ...(input.position !== undefined ? { position: input.position } : {}),
            ...(input.state !== undefined ? { state: input.state } : {})
          }
        })
      )
    )
  },
  'libraries.removeRoot'(args) {
    const input = args.envelope.input as {
      libraryId: number
      rootId: number
      planId: string
      planDigest: string
    }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'R', mutation.operationId)
    return commit(args, () =>
      runMaintenance(() => {
        const preview = previewLibraryPathRemoval({
          libraryId: input.libraryId,
          rootId: input.rootId
        })
        if (preview.impactRevision !== input.planDigest) {
          throw structuredError('VERSION_CONFLICT', '根目录影响范围已变化，请重新预览后重试', undefined, mutation.operationId)
        }
        const owned =
          preview.localResourceCount +
          preview.strmResourceCount +
          preview.pendingScanResourceCount +
          preview.unrecognizedFileCount
        if (owned > 0) {
          return confirmLibraryPathRemoval({
            libraryId: input.libraryId,
            rootId: input.rootId,
            expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
            expectedImpactRevision: input.planDigest
          })
        }
        return mediaLibraries.removeRoot({
          libraryId: input.libraryId,
          rootId: input.rootId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
          expectedImpactRevision: input.planDigest
        })
      })
    )
  },
  'libraries.cancelRootRemoval'(args) {
    const input = args.envelope.input as { libraryId: number; rootId: number }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    return commit(args, () =>
      runMaintenance(() =>
        mediaLibraries.cancelRootRemoval({
          libraryId: input.libraryId,
          rootId: input.rootId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId)
        })
      )
    )
  },
  'scans.run'(args) {
    const input = args.envelope.input as { libraryId: number }
    const mutation = requireMutation(args.envelope)
    assertLibraryConfigVersions(input.libraryId, mutation.expectedVersions, mutation.operationId)
    const accepted = acceptTask(args, () =>
      enqueueLibraryScan({ libraryId: input.libraryId, operationId: mutation.operationId })
    ) as { receipt: unknown; taskId: string; outcome?: string }
    if (accepted.outcome === 'applied') {
      queueMicrotask(() => startLibraryScan(accepted.taskId))
    }
    return { receipt: accepted.receipt, taskId: accepted.taskId }
  },
  'scans.cancel'(args) {
    const input = args.envelope.input as { libraryId: number; taskId?: string }
    return commit(args, () => requestLibraryScanCancel(input))
  },
  'scans.getLatest'(args) {
    const input = args.envelope.input as { libraryId: number }
    return catalogScanLatest(input.libraryId)
  },
  'scans.auditGet'(args) {
    const input = args.envelope.input as { libraryId: number }
    return catalogScanAuditGet(input.libraryId)
  },
  'scans.auditHeader'(args) {
    const input = args.envelope.input as { libraryId: number }
    return catalogScanAuditHeader(input.libraryId)
  },
  'scans.auditPage'(args) {
    const input = args.envelope.input as {
      libraryId: number
      section?: 'files' | 'removedResources' | 'promotedResources' | 'deletedVideos' | 'pendingGroups'
      outcome?: 'added' | 'updated' | 'pending' | 'skipped' | 'unrecognized' | 'strm_failure' | 'processing_failure'
      attention?: boolean
      limit?: number
      offset?: number
    }
    return catalogScanAuditPage(input.libraryId, {
      section: input.section,
      outcome: input.outcome,
      attention: input.attention,
      limit: input.limit,
      offset: input.offset
    })
  },
  'scans.auditViewPage'(args) {
    const input = args.envelope.input as ScanAuditViewQuery & { libraryId: number }
    const { libraryId, ...query } = input
    return catalogScanAuditViewPage(libraryId, query)
  },
  'files.renamePreview'(args) {
    const input = args.envelope.input as {
      libraryId: number
      location: { rootId: number; relativePath: string }
      newFileName: string
    }
    return previewRenameCatalogFile(input)
  },
  async 'files.rename'(args) {
    const input = args.envelope.input as {
      libraryId: number
      resourceId?: number
      location: { rootId: number; relativePath: string }
      newFileName: string
      planId: string
      planDigest: string
    }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'R', mutation.operationId)
    const result = await renameCatalogFile({
      libraryId: input.libraryId,
      ...(input.resourceId != null ? { resourceId: input.resourceId } : {}),
      location: input.location,
      newFileName: input.newFileName,
      planDigest: input.planDigest
    })
    return commit(args, () => result)
  },
  async 'files.importManual'(args) {
    const input = args.envelope.input as {
      libraryId: number
      location: { rootId: number; relativePath: string }
      code: string
      target: VideoResourceImportTarget
    }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'R', mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'V', mutation.operationId)
    const result = await importCatalogManualFile(input)
    return commit(args, () => result)
  },
  'nfo.getOptions'() {
    return getCatalogNfoOptions()
  },
  'nfo.updatePreferences'(args) {
    const input = args.envelope.input as NfoExportPreferences
    return commit(args, () => updateCatalogNfoPreferences(input))
  },
  'nfo.plan'(args) {
    const input = args.envelope.input as NfoExportPlanRequest
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'C', mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'V', mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'R', mutation.operationId)
    return commit(args, () => {
      const preview = planCatalogNfoExport(input)
      return { ...preview, planDigest: peekCatalogNfoPlanDigest(preview.planId) }
    })
  },
  'nfo.discardPlan'(args) {
    const input = args.envelope.input as { planId: string }
    return commit(args, () => {
      discardCatalogNfoPlan(input.planId)
      return { ok: true }
    })
  },
  'nfo.start'(args) {
    const input = args.envelope.input as { planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    requireRootGeneration(mutation.expectedVersions, mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'C', mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'V', mutation.operationId)
    requireVersionField(mutation.expectedVersions, 'R', mutation.operationId)
    const accepted = acceptTask(args, () =>
      enqueueCatalogNfoExport(input.planId, input.planDigest, mutation.operationId)
    ) as { receipt: unknown; taskId: string; outcome?: string }
    if (accepted.outcome === 'applied') {
      queueMicrotask(() => startCatalogNfoExportTask(accepted.taskId))
    }
    return { receipt: accepted.receipt, taskId: accepted.taskId }
  },
  'nfo.terminate'(args) {
    const input = args.envelope.input as { taskId: string }
    return commit(args, () => terminateCatalogNfoExport(input.taskId))
  },
  'nfo.state'() {
    return catalogNfoState()
  },
  'tasks.get'(args) {
    const input = args.envelope.input as { taskId: string }
    const read = () => {
      const task = readCatalogTask(input.taskId)
      if (!task) throw structuredError('INVALID_INPUT', '任务不存在')
      return task
    }
    const stalled = stallCatalogTaskGetForTests()
    return stalled ? stalled.then(read) : read()
  },
  'tasks.list'(args) {
    const input = args.envelope.input as { libraryId?: number; limit?: number; offset?: number }
    return listCatalogTasks(input)
  },
  'tasks.cancel'(args) {
    const input = args.envelope.input as { taskId: string }
    return commit(args, () => {
      const task = readCatalogTask(input.taskId)
      if (!task) throw structuredError('INVALID_INPUT', '任务不存在')
      if (task.kind === 'scan') {
        if (task.libraryId == null) throw structuredError('INVALID_INPUT', '扫描任务缺少媒体库')
        return requestLibraryScanCancel({ libraryId: task.libraryId, taskId: task.taskId })
      }
      if (task.kind === 'nfo-export') return terminateCatalogNfoExport(task.taskId)
      throw structuredError('UNSUPPORTED_CAPABILITY', '该任务类型的取消仍待后续阶段接入')
    })
  }
}
