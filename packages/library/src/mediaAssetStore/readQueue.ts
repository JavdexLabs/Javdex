export class AssetReadQueueFullError extends Error {
  constructor() { super('图片读取队列已满') }
}

/** Bounds active reads and waiting request closures; cancelled queued work never opens a file. */
export class AssetReadQueue {
  private active = 0
  private readonly pending: Array<() => void> = []

  constructor(private readonly concurrency = 4, private readonly maxPending = 256) {}

  run<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
      return Promise.reject(new AssetReadQueueFullError())
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        const index = this.pending.indexOf(start)
        if (index !== -1) {
          this.pending.splice(index, 1)
          reject(signal?.reason)
        }
      }
      const start = (): void => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) {
          reject(signal.reason)
          return
        }
        this.active++
        void Promise.resolve().then(read).then(resolve, reject).finally(() => {
          this.active--
          this.pending.shift()?.()
        })
      }
      if (this.active < this.concurrency) start()
      else {
        this.pending.push(start)
        signal?.addEventListener('abort', abort, { once: true })
      }
    })
  }
}
