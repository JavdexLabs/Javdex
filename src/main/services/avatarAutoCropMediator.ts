import { IPC } from '@shared/ipc-channels'
import type { ScrapeIpcEvent, ScrapeIpcEventChannel } from '@shared/scrapeIpcContract'
import type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropResponse,
  ActressAvatarAutoCropTarget
} from '@shared/scrapeTypes'

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
}

export class AvatarAutoCropMediator {
  private batchToken: string | null = null
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
  }

  rendererDisconnected(): void {
    this.batchToken = null
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
    this.dependencies.assertCanBeginBatch()
    const token = this.dependencies.randomId()
    this.batchToken = token
    return token
  }

  endBatch(token: string): boolean {
    if (token !== this.batchToken) return false
    this.batchToken = null
    return true
  }
}
