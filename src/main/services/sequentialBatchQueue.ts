import type { BatchLogEntry, BatchProgress } from '@shared/types'
import { getSettings } from '../settings/settingsStore'

type ProgressListener = (progress: BatchProgress) => void

const MAX_LOGS = 200

export interface QueueItemOutcome {
  success: boolean
  level: BatchLogEntry['level']
  message: string
}

export interface SequentialBatchRun<TTarget> {
  targets: TTarget[]
  startIndex?: number
  initialProgress?: Pick<BatchProgress, 'success' | 'failed' | 'logs'>
  resumeMessage?: string
  startMessage: (total: number) => string
  pausedMessage: string
  cancelledMessage: string
  doneMessage: (progress: BatchProgress) => string
  getCode: (target: TTarget) => string
  runTarget: (target: TTarget) => Promise<QueueItemOutcome>
  exceptionMessage: (target: TTarget, err: Error) => string
  delayAfterTarget?: boolean
  onCheckpoint?: (progress: BatchProgress, nextIndex: number) => void
}

export type SequentialBatchOutcome = 'done' | 'paused' | 'cancelled'

export class SequentialBatchQueue<TTarget> {
  private progress: BatchProgress = this.emptyProgress()
  private listener: ProgressListener | null = null
  private pauseRequested = false
  private cancelRequested = false
  private running = false

  setListener(fn: ProgressListener | null): void {
    this.listener = fn
  }

  getProgress(): BatchProgress {
    return this.progress
  }

  addLog(code: string, level: BatchLogEntry['level'], message: string): void {
    this.log(code, level, message)
    this.emit()
  }

  isRunning(): boolean {
    return this.running
  }

  pause(): void {
    if (this.running) {
      this.pauseRequested = true
      this.emit()
    }
  }

  cancel(): void {
    if (this.running) {
      this.cancelRequested = true
      this.emit()
    }
  }

  /** Clear progress counters and return to idle (e.g. after user terminates a batch). */
  resetToIdle(): void {
    this.progress = this.emptyProgress()
    this.emit()
  }

  async start(run: SequentialBatchRun<TTarget>): Promise<SequentialBatchOutcome> {
    if (this.running) return 'done'

    const startIndex = run.startIndex ?? 0
    const initial = run.initialProgress
    this.progress = {
      ...this.emptyProgress(),
      total: run.targets.length,
      current: startIndex,
      success: initial?.success ?? 0,
      failed: initial?.failed ?? 0,
      logs: initial?.logs ? [...initial.logs] : [],
      status: 'running'
    }
    this.pauseRequested = false
    this.cancelRequested = false
    this.running = true

    if (startIndex > 0) {
      this.log('-', 'info', run.resumeMessage ?? `从第 ${startIndex + 1} 项继续批量任务`)
    } else {
      this.log('-', 'info', run.startMessage(run.targets.length))
    }
    this.emit()

    let outcome: SequentialBatchOutcome = 'done'

    try {
      for (let i = startIndex; i < run.targets.length; i++) {
        if (this.pauseRequested) {
          this.progress.status = 'paused'
          this.progress.current = i
          this.progress.currentCode = null
          this.log('-', 'info', run.pausedMessage)
          run.onCheckpoint?.(this.snapshotProgress(), i)
          outcome = 'paused'
          break
        }
        if (this.cancelRequested) {
          this.progress.status = 'cancelled'
          this.progress.currentCode = null
          this.log('-', 'info', run.cancelledMessage)
          outcome = 'cancelled'
          break
        }

        const target = run.targets[i]
        const code = run.getCode(target)
        this.progress.current = i + 1
        this.progress.currentCode = code
        this.emit()

        try {
          const itemOutcome = await run.runTarget(target)
          if (itemOutcome.success) this.progress.success += 1
          else this.progress.failed += 1
          this.log(code, itemOutcome.level, itemOutcome.message)
        } catch (err) {
          this.progress.failed += 1
          this.log(code, 'error', run.exceptionMessage(target, err as Error))
        }

        run.onCheckpoint?.(this.snapshotProgress(), i + 1)
        this.emit()

        const isLast = i === run.targets.length - 1
        if (!isLast && !this.pauseRequested && !this.cancelRequested && run.delayAfterTarget !== false) {
          const delay = this.randomDelay()
          this.log('-', 'info', `等待 ${(delay / 1000).toFixed(1)}s 后继续...`)
          this.emit()
          await this.sleep(delay)
        }
      }

      if (outcome === 'done' && this.progress.status === 'running') {
        this.progress.status = 'done'
        this.log('-', 'info', run.doneMessage(this.progress))
      }
    } finally {
      this.progress.currentCode = null
      this.running = false
      this.emit()
    }

    return outcome
  }

  private snapshotProgress(): BatchProgress {
    return { ...this.progress, logs: [...this.progress.logs] }
  }

  private emptyProgress(): BatchProgress {
    return {
      total: 0,
      current: 0,
      success: 0,
      failed: 0,
      currentCode: null,
      status: 'idle',
      logs: []
    }
  }

  private log(code: string, level: BatchLogEntry['level'], message: string): void {
    const entry: BatchLogEntry = {
      time: new Date().toISOString(),
      code,
      level,
      message
    }
    this.progress.logs.push(entry)
    if (this.progress.logs.length > MAX_LOGS) {
      this.progress.logs.splice(0, this.progress.logs.length - MAX_LOGS)
    }
  }

  private emit(): void {
    this.listener?.({ ...this.progress, logs: [...this.progress.logs] })
  }

  private randomDelay(): number {
    const { batchDelayMinMs, batchDelayMaxMs } = getSettings()
    const min = Math.max(0, batchDelayMinMs)
    const max = Math.max(min, batchDelayMaxMs)
    return Math.floor(min + Math.random() * (max - min))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
