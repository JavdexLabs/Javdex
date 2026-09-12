import { Worker } from 'node:worker_threads'
import type { WebCatalogQueryReads } from '@http/catalogWorkerAdapter'
import type { WebBrowseQuery, WebCollections, WebHome } from '@http/catalogQueryRequest'
import type { WebBrowse } from '@shared/webTypes'

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string }

function abortError(): Error {
  const error = new Error('Catalog read aborted')
  error.name = 'AbortError'
  return error
}

export function createWebCatalogWorkerTransport(entryPath: string, databasePath: string): Worker {
  const worker = new Worker(entryPath, { workerData: { databasePath }, execArgv: [] })
  const terminateNative = worker.terminate.bind(worker)
  worker.on('error', () => {})
  let retirement: Promise<number> | undefined
  worker.terminate = () => {
    if (retirement) return retirement
    retirement = new Promise<number>((resolve, reject) => {
      if (worker.threadId === -1) {
        resolve(0)
        return
      }
      const finish = (code: number): void => {
        clearTimeout(timer)
        worker.off('exit', finish)
        resolve(code)
      }
      const fail = (error: unknown): void => {
        clearTimeout(timer)
        worker.off('exit', finish)
        reject(error)
      }
      worker.once('exit', finish)
      const timer = setTimeout(() => {
        void terminateNative().then(finish, fail)
      }, 1000)
      try {
        worker.postMessage({ type: 'close' })
      } catch {
        void terminateNative().then(finish, fail)
      }
    })
    return retirement
  }
  return worker
}

export class WebCatalogWorkerClient implements WebCatalogQueryReads {
  private worker?: Worker
  private ready = false
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private starting?: Promise<void>
  private disposed = false

  constructor(
    private readonly entryPath: string,
    private readonly databasePath: string
  ) {}

  readWebBrowse(query: WebBrowseQuery, signal?: AbortSignal): Promise<WebBrowse> {
    return this.request('web-browse', query, signal) as Promise<WebBrowse>
  }

  readWebHome(seed: string, signal?: AbortSignal): Promise<WebHome> {
    return this.request('web-home', { seed }, signal) as Promise<WebHome>
  }

  readWebCollections(signal?: AbortSignal): Promise<WebCollections> {
    return this.request('web-collections', {}, signal) as Promise<WebCollections>
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const error = new Error('Catalog read client disposed')
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
    const worker = this.worker
    this.worker = undefined
    if (worker) await worker.terminate()
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) return
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolve, reject) => {
      const worker = createWebCatalogWorkerTransport(this.entryPath, this.databasePath)
      this.worker = worker
      const timer = setTimeout(() => {
        reject(new Error('Catalog worker startup timed out'))
        void this.dispose()
      }, 15_000)
      const onMessage = (message: WorkerMessage): void => {
        if (message.type === 'ready') {
          clearTimeout(timer)
          this.ready = true
          resolve()
          return
        }
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (message.type === 'result') pending.resolve(message.result)
        else pending.reject(new Error(message.message))
      }
      worker.on('message', onMessage)
      worker.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    await this.starting
  }

  private async request(
    operation: 'web-browse' | 'web-home' | 'web-collections',
    query: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.disposed) throw new Error('Catalog read client disposed')
    if (signal?.aborted) throw abortError()
    await this.ensureStarted()
    const id = ++this.nextId
    return await new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id)
        reject(abortError())
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort)
          reject(error)
        }
      })
      this.worker?.postMessage({ type: 'read', id, operation, query })
    })
  }
}
