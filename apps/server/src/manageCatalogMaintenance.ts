import fs from 'node:fs'
import path from 'node:path'
import { isStructuredError, structuredError, toStructuredError } from '@shared/protocol/errors'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { ManageOperationId } from '@shared/manage/operations'
import type { NfoExportPlanRequest, NfoExportPreferences } from '@shared/nfoExportTypes'
import type { VideoResourceImportTarget } from '@shared/videoTypes'
import type { ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import type { LibraryScanAudit } from '@shared/libraryTypes'
import {
  getMediaLibraryDetail,
  getMediaLibraryRoot,
  MediaLibraryRepoError
} from '@library/db/mediaLibraryRepo'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'
import { acceptCatalogTask } from '@library/catalog/catalogOperations'
import { listCatalogTasks, readCatalogTask } from '@library/catalog/catalogTasks'
import {
  catalogScanAuditGet,
  catalogScanAuditHeader,
  catalogScanAuditPage,
  catalogScanAuditViewPage,
  catalogScanLatest
} from '@library/catalog/catalogAuditRead'
import {
  executeCatalogFileMaintenance,
  previewRenameCatalogFile
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

function relativeAuditPath(
  filePath: string,
  roots: Array<{ path: string; realPath?: string | null }>
): string | null {
  for (const root of roots) {
    for (const base of [root.realPath, root.path].filter((value): value is string => Boolean(value))) {
      const relative = path.relative(base, filePath)
      if (
        relative &&
        !path.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`)
      ) {
        return relative.split(path.sep).join('/')
      }
    }
  }
  return null
}

function projectRemoteAuditPath(
  libraryId: number,
  value: string | null,
  rootId?: number | null
): string | null {
  if (value == null || !path.isAbsolute(value)) return value
  const detail = getMediaLibraryDetail(libraryId)
  const roots = detail?.roots ?? []
  const root = rootId == null ? null : getMediaLibraryRoot(libraryId, rootId)
  const relative = relativeAuditPath(value, root ? [root] : roots)
  return relative ?? path.basename(value)
}

function projectRemoteAudit(libraryId: number, audit: LibraryScanAudit | null): LibraryScanAudit | null {
  if (!audit) return null
  return {
    ...audit,
    files: audit.files.map((entry) => ({
      ...entry,
      filePath: projectRemoteAuditPath(libraryId, entry.filePath, entry.rootId) ?? entry.filePath
    })),
    removedResources: audit.removedResources.map((entry) => ({
      ...entry,
      sourcePath: projectRemoteAuditPath(libraryId, entry.sourcePath)
    })),
    promotedResources: audit.promotedResources.map((entry) => ({
      ...entry,
      sourcePath: projectRemoteAuditPath(libraryId, entry.sourcePath)
    }))
  }
}

function projectRemoteAuditPage(
  libraryId: number,
  page: ReturnType<typeof catalogScanAuditPage>
): ReturnType<typeof catalogScanAuditPage> {
  if (!page.snapshot) return page
  const detail = getMediaLibraryDetail(libraryId)
  const roots = detail?.roots ?? []
  return {
    ...page,
    items: page.items.map((item) => {
      const entry = { ...item.entry }
      const rootId = typeof entry.rootId === 'number' ? entry.rootId : undefined
      for (const key of ['filePath', 'sourcePath', 'path']) {
        const value = entry[key]
        if (typeof value !== 'string') continue
        if (!path.isAbsolute(value)) continue
        const root = rootId == null ? null : getMediaLibraryRoot(libraryId, rootId)
        const relative = relativeAuditPath(value, root ? [root] : roots)
        entry[key] = relative ?? path.basename(value)
      }
      return { ...item, entry }
    })
  }
}

function projectRemoteAuditHeader(
  libraryId: number,
  header: ReturnType<typeof catalogScanAuditHeader>
): ReturnType<typeof catalogScanAuditHeader> {
  if (!header.summary) return header
  return {
    ...header,
    summary: {
      ...header.summary,
      offlineFolders: header.summary.offlineFolders.map(
        (folder) => projectRemoteAuditPath(libraryId, folder) ?? folder
      )
    }
  }
}

/** Remote clients must never receive server-local absolute file paths. */
function projectRemoteAuditViewPage(
  libraryId: number,
  page: ReturnType<typeof catalogScanAuditViewPage>
): ReturnType<typeof catalogScanAuditViewPage> {
  const detail = getMediaLibraryDetail(libraryId)
  const roots = detail?.roots ?? []
  return {
    ...page,
    items: page.items.map((item) => {
      if (!item.path) return item
      const root = item.rootId == null ? null : getMediaLibraryRoot(libraryId, item.rootId)
      const relative = relativeAuditPath(
        item.path,
        root ? [root] : roots
      )
      return relative ? { ...item, path: relative } : { ...item, path: undefined }
    })
  }
}

function resolveRemoteAuditAnchor(
  libraryId: number,
  anchor: ScanAuditViewQuery['anchor']
): ScanAuditViewQuery['anchor'] {
  if (!anchor || anchor.kind !== 'path' || anchor.rootId == null || path.isAbsolute(anchor.value)) {
    return anchor
  }
  const root = getMediaLibraryRoot(libraryId, anchor.rootId)
  if (!root) return anchor
  return {
    ...anchor,
    value: path.resolve(root.path, anchor.value)
  }
}

function mapMaintenanceError(error: unknown): never {
  if (isStructuredError(error)) throw error
  if (error instanceof MediaLibraryRepoError) {
    if (error.code === 'REVISION_CONFLICT') {
      throw structuredError('VERSION_CONFLICT', error.message)
    }
    if (error.code === 'LIBRARY_BUSY') {
      throw structuredError('MAINTENANCE_BUSY', error.message)
    }
    throw structuredError('INVALID_INPUT', error.message)
  }
  throw toStructuredError(error)
}

function runMaintenance<T>(work: () => T): T {
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
    return projectRemoteAudit(input.libraryId, catalogScanAuditGet(input.libraryId))
  },
  'scans.auditHeader'(args) {
    const input = args.envelope.input as { libraryId: number }
    return projectRemoteAuditHeader(input.libraryId, catalogScanAuditHeader(input.libraryId))
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
    return projectRemoteAuditPage(input.libraryId, catalogScanAuditPage(input.libraryId, {
      section: input.section,
      outcome: input.outcome,
      attention: input.attention,
      limit: input.limit,
      offset: input.offset
    }))
  },
  'scans.auditViewPage'(args) {
    const input = args.envelope.input as ScanAuditViewQuery & { libraryId: number }
    const { libraryId, ...query } = input
    return projectRemoteAuditViewPage(
      libraryId,
      catalogScanAuditViewPage(libraryId, {
        ...query,
        anchor: resolveRemoteAuditAnchor(libraryId, query.anchor)
      })
    )
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
    const result = await executeCatalogFileMaintenance({
      ...mutation,
      operation: 'files.rename',
      input,
      writerEpoch: args.auth.epoch
    }, { database: args.database, remoteSafe: true })
    return { receipt: result.receipt, ...result.data }
  },
  async 'files.importManual'(args) {
    const input = args.envelope.input as {
      libraryId: number
      location: { rootId: number; relativePath: string }
      code: string
      target: VideoResourceImportTarget
    }
    const mutation = requireMutation(args.envelope)
    const result = await executeCatalogFileMaintenance({
      ...mutation,
      operation: 'files.importManual',
      input,
      writerEpoch: args.auth.epoch
    }, { database: args.database })
    return { receipt: result.receipt, ...result.data }
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
