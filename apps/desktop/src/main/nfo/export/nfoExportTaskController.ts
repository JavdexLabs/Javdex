import crypto from 'node:crypto'
import type {
  NfoExportPlanPreview,
  NfoExportPlanRequest,
  NfoExportProgressEvent,
  NfoExportStartResult,
  NfoExportStateEvent
} from '@shared/nfoExportTypes'
import { maintenanceTaskGate, type MaintenanceTaskGate, type MaintenanceTaskLease } from '@library/scan/maintenanceTaskGate'
import { mediaAssetStore, type MediaAssetStore } from '@library/mediaAssetStore'
import { nfoExportModule, type InternalNfoExportPlan, type NfoExportModule } from './nfoExportModule'
import { sanitizeNfoExportMessage } from '@library/nfo/export/nfoExportSafety'

interface HeldPlan {
  plan: InternalNfoExportPlan
  maintenanceLease: MaintenanceTaskLease
  assetLease: { release(): void }
}

interface RunningTask {
  id: string
  terminated: boolean
  promise: Promise<void>
}

export class NfoExportTaskController {
  private held: HeldPlan | null = null
  private running: RunningTask | null = null
  private planning: Promise<NfoExportPlanPreview> | null = null
  private listeners = new Set<(event: NfoExportProgressEvent | NfoExportStateEvent) => void>()

  constructor(
    private readonly module: Pick<NfoExportModule, 'plan' | 'apply'> = nfoExportModule,
    private readonly gate: Pick<MaintenanceTaskGate, 'tryAcquire'> = maintenanceTaskGate,
    private readonly assets: Pick<MediaAssetStore, 'acquireStableReadLease'> = mediaAssetStore
  ) {}

  onEvent(listener: (event: NfoExportProgressEvent | NfoExportStateEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get isForegroundBlocking(): boolean {
    return this.running != null
  }

  get hasActivePlanOrTask(): boolean {
    return this.held != null || this.running != null || this.planning != null
  }

  async plan(request: NfoExportPlanRequest): Promise<NfoExportPlanPreview> {
    if (this.running) throw new Error('NFO 导出正在执行')
    if (this.planning) throw new Error('NFO 导出正在生成预览')
    this.releaseHeldPlan()
    const maintenanceLease = this.gate.tryAcquire('nfo-export')
    if (!maintenanceLease) throw new Error('已有扫描或资源维护任务正在运行')
    let assetLease: { release(): void } | null = null
    try {
      assetLease = this.assets.acquireStableReadLease()
      const heldAssetLease = assetLease
      this.planning = this.module.plan(request).then((plan) => {
        this.held = { plan, maintenanceLease, assetLease: heldAssetLease }
        return plan.preview
      })
      return await this.planning
    } catch (error) {
      assetLease?.release()
      maintenanceLease.release()
      throw error
    } finally {
      this.planning = null
    }
  }

  discardPlan(planId: string): void {
    if (this.running) throw new Error('NFO 导出正在执行')
    if (this.held?.plan.preview.planId !== planId) throw new Error('NFO 导出计划不存在或已失效')
    this.releaseHeldPlan()
  }

  start(planId: string): NfoExportStartResult {
    if (this.running) throw new Error('NFO 导出正在执行')
    if (!this.held || this.held.plan.preview.planId !== planId) {
      throw new Error('NFO 导出计划不存在或已失效')
    }
    const taskId = crypto.randomUUID()
    const held = this.held
    const task: RunningTask = { id: taskId, terminated: false, promise: Promise.resolve() }
    this.running = task
    task.promise = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      this.emit({ taskId, state: 'running' })
      return this.module.apply(
        held.plan,
        taskId,
        { isTerminated: () => task.terminated },
        (completed, total, current) => this.emit({
          taskId,
          completed,
          total,
          ...(current ? { current: {
            id: current.id,
            kind: current.kind,
            displayName: current.displayName,
            videoCode: current.videoCode
          } } : {})
        })
      )
    }).then((report) => {
      this.releaseHeldPlan()
      if (this.running === task) this.running = null
      this.emit({ taskId, state: 'finished', report })
    }, (error) => {
      this.releaseHeldPlan()
      if (this.running === task) this.running = null
      const now = new Date().toISOString()
      this.emit({
        taskId,
        state: 'finished',
        report: {
          taskId,
          startedAt: now,
          finishedAt: now,
          terminated: task.terminated,
          writtenCount: 0,
          skippedCount: 0,
          failedCount: 1,
          items: [{
            id: 'task',
            kind: 'nfo',
            displayName: 'NFO 导出任务',
            videoCode: '',
            disposition: 'failed',
            message: sanitizeNfoExportMessage(error)
          }]
        }
      })
    })
    return { taskId }
  }

  terminate(taskId: string): void {
    if (!this.running || this.running.id !== taskId) throw new Error('NFO 导出任务不存在')
    this.running.terminated = true
  }

  async dispose(): Promise<void> {
    // Planning also owns both leases while yielding between image decodes.
    await this.planning?.catch(() => undefined)
    if (this.running) {
      this.running.terminated = true
      await this.running.promise
    }
    this.releaseHeldPlan()
  }

  private emit(event: NfoExportProgressEvent | NfoExportStateEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private releaseHeldPlan(): void {
    if (!this.held) return
    this.held.assetLease.release()
    this.held.maintenanceLease.release()
    this.held = null
  }
}

export const nfoExportTaskController = new NfoExportTaskController()
