import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  NfoExportOptions,
  NfoExportPlanPreview,
  NfoExportPlanRequest,
  NfoExportPreferences,
  NfoExportReport,
  NfoExportStartResult,
  NfoExportStateEvent
} from '@shared/nfoExportTypes'
import { DEFAULT_NFO_EXPORT_PREFERENCES } from '@shared/nfoExportTypes'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import { structuredError } from '@shared/protocol/errors'
import {
  consumeMaintenancePlan,
  digestMaintenancePlan,
  discardMaintenancePlan,
  readMaintenancePlan,
  saveMaintenancePlan
} from './catalogMaintenancePlans'
import { readCatalogSetting, writeCatalogSetting } from './catalogSettings'
import { hasOpenCatalogMaintenance, putCatalogTask, readCatalogTask } from './catalogTasks'
import { readCatalogIdentity } from './catalogIdentity'
import { handoffWaitingBlocksNewMaintenance } from './catalogWriter'
import { nfoExportRepository } from '@library/nfo/export/nfoExportRepository'
import {
  NFO_EXPORT_PROFILES,
  renderNfoExportDocument
} from '@library/nfo/export/nfoExportProfiles'
import { sanitizeNfoExportMessage } from '@library/nfo/export/nfoExportSafety'
import { authorizeMediaLibraryRootFile } from '@library/scan/mediaLibraryRootFileGuard'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'

const SETTINGS_KEY = 'nfo.preferences'
const running = new Map<string, { terminated: boolean }>()
const pendingApplies = new Map<string, { stored: StoredNfoPlan; handle: { terminated: boolean } }>()

interface StoredNfoPlanFile {
  id: string
  kind: 'nfo'
  displayName: string
  videoCode: string
  action: 'create' | 'replace' | 'skip-existing' | 'conflict' | 'unavailable'
  bytes: number
  targetPath: string
  resourceId: number
  warning?: string
}

interface StoredNfoPlan {
  preview: NfoExportPlanPreview
  files: StoredNfoPlanFile[]
}

function identityCatalogId(): string {
  const identity = readCatalogIdentity()
  if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化')
  return identity.catalogId
}

function activePreferences(input: NfoExportPreferences): NfoExportPreferences {
  const active = new Set(nfoExportRepository.listActiveLibraries().map((library) => library.id))
  const requested = Array.isArray(input.libraryIds) ? input.libraryIds : []
  return {
    ...input,
    libraryIds: Array.from(new Set(requested.filter((id) => active.has(id))))
  }
}

export function getCatalogNfoOptions(): NfoExportOptions {
  const stored = readCatalogSetting<NfoExportPreferences>(SETTINGS_KEY, DEFAULT_NFO_EXPORT_PREFERENCES)
  const preferences = activePreferences(stored)
  if (JSON.stringify(preferences) !== JSON.stringify(stored)) {
    writeCatalogSetting(SETTINGS_KEY, preferences)
  }
  return {
    libraries: nfoExportRepository.listActiveLibraries(),
    profiles: [...NFO_EXPORT_PROFILES],
    preferences
  }
}

export function updateCatalogNfoPreferences(input: NfoExportPreferences): NfoExportPreferences {
  const preferences = activePreferences(input)
  writeCatalogSetting(SETTINGS_KEY, preferences)
  return preferences
}

function assertWritableDirectory(directory: string): void {
  fs.accessSync(directory, fs.constants.W_OK)
}

function atomicWrite(targetPath: string, bytes: Buffer): void {
  const directory = path.dirname(targetPath)
  assertWritableDirectory(directory)
  const temporary = `${targetPath}.javdex-tmp-${process.pid}`
  fs.writeFileSync(temporary, bytes, { mode: 0o644 })
  fs.renameSync(temporary, targetPath)
}

export function planCatalogNfoExport(request: NfoExportPlanRequest): NfoExportPlanPreview {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
  const lease = maintenanceTaskGate.tryAcquire('nfo-export')
  if (!lease) throw structuredError('MAINTENANCE_BUSY', '已有扫描或资源维护任务正在运行')
  try {
    const preferences = activePreferences(request)
    if (preferences.libraryIds.length === 0) {
      throw structuredError('INVALID_INPUT', '请选择至少一个可用媒体库')
    }
    writeCatalogSetting(SETTINGS_KEY, preferences)
    const warnings: string[] = []
    if (
      request.includeCover ||
      request.includeFanart ||
      request.includeSamples ||
      request.includeActorAvatars
    ) {
      warnings.push('服务端第一版 NFO 导出只写 XML 资料文件，跳过封面/fanart/样张/头像编码。')
    }
    const files: StoredNfoPlanFile[] = []
    const snapshots = nfoExportRepository.listResourceSnapshots(preferences.libraryIds)
    let skippedNoAnchorCount = 0
    const exportedVideoIds = new Set<number>()
    for (const snapshot of snapshots) {
      if (!snapshot.anchorPath || snapshot.rootId == null || !snapshot.root) {
        skippedNoAnchorCount += 1
        continue
      }
      try {
        authorizeMediaLibraryRootFile(
          snapshot.libraryId,
          snapshot.rootId,
          snapshot.anchorPath,
          snapshot.root
        )
        const anchorReal = fs.realpathSync.native(snapshot.anchorPath)
        const directory = path.dirname(anchorReal)
        try {
          assertWritableDirectory(directory)
        } catch {
          files.push({
            id: randomUUID(),
            kind: 'nfo',
            displayName: `${snapshot.code}.nfo`,
            videoCode: snapshot.code,
            action: 'unavailable',
            bytes: 0,
            targetPath: path.join(directory, `${path.basename(anchorReal, path.extname(anchorReal))}.nfo`),
            resourceId: snapshot.resourceId,
            warning: '目标目录不可写'
          })
          continue
        }
        const targetPath = path.join(
          directory,
          `${path.basename(anchorReal, path.extname(anchorReal))}.nfo`
        )
        const bytes = renderNfoExportDocument(request.profileId, {
          code: snapshot.code,
          title: snapshot.title,
          originalTitle: snapshot.originalTitle,
          summary: snapshot.summary,
          releaseDate: snapshot.releaseDate,
          maker: snapshot.maker,
          publisher: snapshot.publisher,
          series: snapshot.series,
          director: snapshot.director,
          durationSeconds: snapshot.durationSeconds,
          tags: snapshot.tags,
          actors: snapshot.actors.map((actor) => ({ name: actor.name, gender: actor.gender })),
          ratings: snapshot.ratings,
          identities: snapshot.identities
        })
        let action: StoredNfoPlanFile['action'] = 'create'
        if (fs.existsSync(targetPath)) {
          action = request.collisionPolicy === 'replace' ? 'replace' : 'skip-existing'
        }
        files.push({
          id: randomUUID(),
          kind: 'nfo',
          displayName: path.basename(targetPath),
          videoCode: snapshot.code,
          action,
          bytes: bytes.length,
          targetPath,
          resourceId: snapshot.resourceId
        })
        exportedVideoIds.add(snapshot.videoId)
      } catch (error) {
        warnings.push(sanitizeNfoExportMessage(error))
      }
    }
    const count = (action: StoredNfoPlanFile['action']): number =>
      files.filter((file) => file.action === action).length
    const preview: NfoExportPlanPreview = {
      planId: randomUUID(),
      request: { ...request, ...preferences },
      summary: {
        videoCount: exportedVideoIds.size,
        resourceCount: files.length,
        fileCount: files.length,
        createCount: count('create'),
        replaceCount: count('replace'),
        skipCount: count('skip-existing'),
        conflictCount: count('conflict'),
        unavailableCount: count('unavailable'),
        skippedNoAnchorCount,
        warningCount: warnings.length,
        sampleCount: 0,
        estimatedBytes: files
          .filter((file) => file.action === 'create' || file.action === 'replace')
          .reduce((total, file) => total + file.bytes, 0)
      },
      files: files.map(({ targetPath: _targetPath, resourceId: _resourceId, ...file }) => file),
      warnings
    }
    const stored: StoredNfoPlan = { preview, files }
    const saved = saveMaintenancePlan('nfo', stored, digestMaintenancePlan(preview), {
      planId: preview.planId
    })
    preview.planId = saved.planId
    return preview
  } finally {
    lease.release()
  }
}

export function discardCatalogNfoPlan(planId: string): void {
  if ([...running.values()].some((task) => !task.terminated) && running.size > 0) {
    const active = [...running.keys()]
    if (active.length > 0) {
      const task = readCatalogTask(active[0])
      if (task && (task.state === 'running' || task.state === 'cancelRequested')) {
        throw structuredError('MAINTENANCE_BUSY', 'NFO 导出正在执行')
      }
    }
  }
  discardMaintenancePlan(planId)
}

export function resetCatalogNfoRuntime(): void {
  running.clear()
  pendingApplies.clear()
}

export function enqueueCatalogNfoExport(
  planId: string,
  planDigest: string,
  operationId: string
): NfoExportStartResult {
  if (handoffWaitingBlocksNewMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '交接等待期间不能开始新的维护')
  }
  if (maintenanceTaskGate.active || hasOpenCatalogMaintenance()) {
    throw structuredError('MAINTENANCE_BUSY', '已有扫描或资源维护任务正在运行')
  }
  const stored = consumeMaintenancePlan<StoredNfoPlan>(planId, 'nfo', planDigest)
  const taskId = randomUUID()
  putCatalogTask({
    owner: 'catalog',
    taskId,
    operationId,
    catalogId: identityCatalogId(),
    kind: 'nfo-export',
    state: 'queued',
    taskRevision: 1,
    progressSeq: 0,
    label: 'NFO 导出排队'
  })
  const handle = { terminated: false }
  running.set(taskId, handle)
  pendingApplies.set(taskId, { stored: stored.payload, handle })
  return { taskId }
}

export function startCatalogNfoExportTask(taskId: string): void {
  const pending = pendingApplies.get(taskId)
  if (!pending) return
  pendingApplies.delete(taskId)
  void applyNfoPlan(taskId, pending.stored, pending.handle)
}

export function startCatalogNfoExport(
  planId: string,
  planDigest: string,
  operationId: string
): NfoExportStartResult {
  const result = enqueueCatalogNfoExport(planId, planDigest, operationId)
  startCatalogNfoExportTask(result.taskId)
  return result
}

export function terminateCatalogNfoExport(taskId: string): CatalogTaskSnapshot {
  const handle = running.get(taskId)
  const task = readCatalogTask(taskId)
  if (!task || task.kind !== 'nfo-export') {
    throw structuredError('INVALID_INPUT', 'NFO 导出任务不存在')
  }
  if (handle) handle.terminated = true
  if (task.state === 'queued' || task.state === 'running') {
    return putCatalogTask({
      ...task,
      state: 'cancelRequested',
      taskRevision: task.taskRevision + 1,
      label: '已请求终止 NFO 导出'
    })
  }
  return task
}

export function catalogNfoState(): NfoExportStateEvent | { taskId: null; state: 'idle' } {
  const row = [...running.keys()]
    .map((taskId) => readCatalogTask(taskId))
    .find((task) => task && (task.state === 'running' || task.state === 'queued' || task.state === 'cancelRequested'))
  if (!row) return { taskId: null, state: 'idle' }
  return { taskId: row.taskId, state: row.state === 'cancelRequested' ? 'running' : 'running' }
}

async function applyNfoPlan(
  taskId: string,
  stored: StoredNfoPlan,
  handle: { terminated: boolean }
): Promise<void> {
  const lease = maintenanceTaskGate.tryAcquire('nfo-export')
  const current = readCatalogTask(taskId)
  if (!current) return
  if (!lease) {
    putCatalogTask({
      ...current,
      state: 'failed',
      taskRevision: current.taskRevision + 1,
      errorCode: 'MAINTENANCE_BUSY',
      label: '已有扫描或资源维护任务正在运行'
    })
    running.delete(taskId)
    return
  }
  putCatalogTask({
    ...current,
    state: 'running',
    taskRevision: current.taskRevision + 1,
    label: 'NFO 导出进行中'
  })
  const report: NfoExportReport = {
    taskId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    terminated: false,
    writtenCount: 0,
    skippedCount: 0,
    failedCount: 0,
    items: []
  }
  try {
    let completed = 0
    for (const file of stored.files) {
      if (handle.terminated) {
        report.terminated = true
        break
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (file.action === 'unavailable' || file.action === 'conflict') {
        report.items.push({
          id: file.id,
          kind: 'nfo',
          displayName: file.displayName,
          videoCode: file.videoCode,
          disposition: file.action
        })
        completed += 1
        continue
      }
      if (file.action === 'skip-existing') {
        report.skippedCount += 1
        report.items.push({
          id: file.id,
          kind: 'nfo',
          displayName: file.displayName,
          videoCode: file.videoCode,
          disposition: 'skipped-existing'
        })
        completed += 1
        continue
      }
      try {
        const snapshot = nfoExportRepository.getResourceSnapshot(file.resourceId)
        if (!snapshot?.anchorPath || snapshot.rootId == null || !snapshot.root) {
          throw new Error('来源资源已变化')
        }
        authorizeMediaLibraryRootFile(
          snapshot.libraryId,
          snapshot.rootId,
          snapshot.anchorPath,
          snapshot.root
        )
        const bytes = renderNfoExportDocument(stored.preview.request.profileId, {
          code: snapshot.code,
          title: snapshot.title,
          originalTitle: snapshot.originalTitle,
          summary: snapshot.summary,
          releaseDate: snapshot.releaseDate,
          maker: snapshot.maker,
          publisher: snapshot.publisher,
          series: snapshot.series,
          director: snapshot.director,
          durationSeconds: snapshot.durationSeconds,
          tags: snapshot.tags,
          actors: snapshot.actors.map((actor) => ({ name: actor.name, gender: actor.gender })),
          ratings: snapshot.ratings,
          identities: snapshot.identities
        })
        atomicWrite(file.targetPath, bytes)
        report.writtenCount += 1
        report.items.push({
          id: file.id,
          kind: 'nfo',
          displayName: file.displayName,
          videoCode: file.videoCode,
          disposition: 'written'
        })
      } catch (error) {
        report.failedCount += 1
        report.items.push({
          id: file.id,
          kind: 'nfo',
          displayName: file.displayName,
          videoCode: file.videoCode,
          disposition: 'failed',
          message: sanitizeNfoExportMessage(error)
        })
      }
      completed += 1
      const live = readCatalogTask(taskId)
      if (live) {
        putCatalogTask({
          ...live,
          progressSeq: live.progressSeq + 1,
          taskRevision: live.taskRevision + 1,
          counts: { completed, total: stored.files.length, written: report.writtenCount }
        })
      }
    }
    report.finishedAt = new Date().toISOString()
    const done = readCatalogTask(taskId)
    if (done) {
      putCatalogTask({
        ...done,
        state: handle.terminated ? 'cancelled' : report.failedCount > 0 ? 'needsInspection' : 'succeeded',
        taskRevision: done.taskRevision + 1,
        label: handle.terminated ? 'NFO 导出已取消' : 'NFO 导出完成'
      })
    }
  } finally {
    lease.release()
    running.delete(taskId)
  }
}

export function peekCatalogNfoPlanDigest(planId: string): string {
  return readMaintenancePlan<StoredNfoPlan>(planId, 'nfo').digest
}
