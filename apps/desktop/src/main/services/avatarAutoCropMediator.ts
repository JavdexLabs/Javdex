import type { ActressAvatarCropTargetPage } from '@shared/actressAvatarCropTypes'
import type { ActressAvatarCropSnapshot } from '@library/db/actressAvatarCropSnapshot'
import { IPC } from '@shared/ipc-channels'
import type { ScrapeIpcEvent, ScrapeIpcEventChannel } from '@shared/scrapeIpcContract'
import type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropResponse,
  ActressAvatarAutoCropTarget
} from '@shared/actressAvatarCropTypes'

export interface AvatarAutoCropMediatorDependencies {
  emit<Channel extends ScrapeIpcEventChannel>(
    channel: Channel,
    payload: ScrapeIpcEvent<Channel>
  ): void
  rendererAvailable(): boolean
  randomId(): string
  autoCropTimeoutMs: number
  /** Queue / scrape availability checks; crop token ownership stays inside the mediator. */
  assertCanBeginBatch(): void
  createBatchTargets?: () => ActressAvatarCropSnapshot
}

export class AvatarAutoCropMediator {
  private batchToken: string | null = null
  private batchTargets: ActressAvatarCropSnapshot | null = null
  private readonly pending = new Map<
    string,
    {
      resolve: (outcome: ActressAvatarAutoCropOutcome) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()

  constructor(private readonly dependencies: AvatarAutoCropMediatorDependencies) {}

  hasActiveBatch(): boolean {
    return this.batchToken !== null
  }

  clearBatchToken(): void {
    this.batchToken = null
    try {
      this.batchTargets?.dispose()
      this.batchTargets = null
    } catch (error) {
      // Retain the failed resource for retry, without blocking disconnect cleanup.
      console.warn('头像任务快照清理失败，将在下次任务前重试', error)
    }
  }

  rendererDisconnected(): void {
    this.clearBatchToken()
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout)
      this.pending.delete(requestId)
      pending.resolve({ status: 'failed', message: '应用窗口不可用' })
    }
  }

  request(target: ActressAvatarAutoCropTarget): Promise<ActressAvatarAutoCropOutcome> {
    if (!this.dependencies.rendererAvailable()) {
      return Promise.resolve({ status: 'failed', message: '应用窗口不可用' })
    }
    const requestId = this.dependencies.randomId()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        resolve({ status: 'failed', message: '智能构图等待超时' })
      }, this.dependencies.autoCropTimeoutMs)
      this.pending.set(requestId, { resolve, timeout })
      this.dependencies.emit(IPC.ACTRESS_AVATAR_AUTO_CROP_REQUEST, { ...target, requestId })
    })
  }

  complete(response: ActressAvatarAutoCropResponse): boolean {
    const pending = this.pending.get(response.requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.pending.delete(response.requestId)
    pending.resolve({ status: response.status, message: response.message })
    return true
  }

  beginBatch(): string {
    if (this.batchToken) {
      throw new Error('批量智能构图正在进行中，请完成或停止后再试')
    }
    // Do not accumulate another snapshot while cleanup of the previous one fails.
    this.batchTargets?.dispose()
    this.batchTargets = null
    this.dependencies.assertCanBeginBatch()
    const token = this.dependencies.randomId()
    this.batchToken = token
    return token
  }

  pageBatchTargets(token: string, afterId: number): ActressAvatarCropTargetPage {
    if (token !== this.batchToken) throw new Error('头像任务令牌已失效')
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error('无效的头像任务游标')
    if (!this.batchTargets) {
      if (!this.dependencies.createBatchTargets) throw new Error('头像任务快照服务不可用')
      this.batchTargets = this.dependencies.createBatchTargets()
    }
    return this.batchTargets.page(afterId)
  }

  endBatch(token: string): boolean {
    if (token !== this.batchToken) return false
    this.clearBatchToken()
    return true
  }
}
