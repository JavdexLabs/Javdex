import type { CatalogScope } from '@shared/mediaLibraryTypes'
import type { VideoQuery } from '@shared/videoTypes'
import type { ScopedVideoListResult, HomeDiscoveryInput, HomeSnapshot, GlobalSearchInput, GlobalSearchResult } from '@shared/catalogTypes'
import type { WebBrowse } from '@shared/webTypes'
import { IPC } from '@shared/ipc-channels'
import { videoIpcSchemas } from '../ipc/ipcCommandSchemas'
import { mediaLibraryIpcSchemas } from '../ipc/mediaLibraryIpcSchemas'
import { normalizeWebBrowseQuery, normalizeWebSeed, type WebBrowseQuery, type WebHome, type WebCollections } from '../web/catalogQueryRequest'
import { normalizeAuditPathRequest } from './scanAuditPathPermission'
import type { ScanAuditReadHeader, ScanAuditViewQuery, ScanAuditViewPage } from '@shared/scanAuditReadTypes'
import type { ScanAuditIndexLimits, ScanAuditIndexPage, ScanAuditIndexQuery, ScanAuditSnapshotIdentity } from './scanAuditReadIndex'
import { normalizeScanAuditReadRequest, normalizeScanAuditViewRequest } from './scanAuditReadRequest'
import type { ClassificationEntityRef, ClassificationImageCandidate, ClassificationListPage, ClassificationPageQuery } from '@shared/classificationTypes'
import type { TagFilterOptionsPage, TagOptionsQuery } from '@shared/commonTypes'

export type CatalogReadPage = ScopedVideoListResult | HomeSnapshot | number[] | WebBrowse | WebHome | WebCollections | boolean | ScanAuditViewPage | ScanAuditReadHeader | ScanAuditIndexPage | TagFilterOptionsPage | ClassificationListPage<ClassificationImageCandidate>
type CatalogReadRequest =
  | { operation: 'scoped-video-list'; scope: CatalogScope; query: VideoQuery }
  | { operation: 'scoped-video-years'; query: CatalogScope }
  | { operation: 'home-load'; query: HomeDiscoveryInput }
  | { operation: 'home-search'; query: GlobalSearchInput }
  | { operation: 'web-browse'; query: WebBrowseQuery }
  | { operation: 'web-home'; query: { seed: string } }
  | { operation: 'web-collections'; query: Record<string, never> }
  | { operation: 'scan-audit-path'; query: {libraryId:number;filePath:string} }
  | { operation: 'scan-audit-view-page'; snapshot: ScanAuditSnapshotIdentity; query: ScanAuditViewQuery; limits: ScanAuditIndexLimits }
  | { operation: 'scan-audit-header'; query: { libraryId: number } }
  | { operation: 'scan-audit-page'; snapshot: ScanAuditSnapshotIdentity; query: ScanAuditIndexQuery; limits: ScanAuditIndexLimits }
  | { operation?: 'tag-options'; query: TagOptionsQuery }
  | { operation: 'classification-images'; entity: ClassificationEntityRef; query: ClassificationPageQuery }
export type CatalogReadCommand = CatalogReadRequest & { type: 'read'; id: number }

export interface CatalogReadContext {
  identity: object
  path: string
  revision: string
}

export type CatalogReadWorkerMessage =
  | { type: 'ready' }
  | { type: 'result'; id: number; result: CatalogReadPage }
  | { type: 'error'; id: number; message: string }

/** Factory returns a transport before it emits ready. off must remove the supplied listener. */
export interface CatalogReadWorkerTransport {
  postMessage(message: CatalogReadCommand): void
  on(event: 'message', listener: (message: CatalogReadWorkerMessage) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  off(event: 'message', listener: (message: CatalogReadWorkerMessage) => void): unknown
  off(event: 'error', listener: (error: Error) => void): unknown
  off(event: 'exit', listener: (code: number) => void): unknown
  terminate(): Promise<unknown>
}

export interface CatalogReadWorkerClientOptions {
  contextProvider: () => CatalogReadContext
  transportFactory: (context: CatalogReadContext) => CatalogReadWorkerTransport
  startupTimeoutMs?: number
  queryTimeoutMs?: number
  queueTimeoutMs?: number
}

interface Subscriber {
  resolve: (page: CatalogReadPage) => void
  reject: (error: Error) => void
  cleanup: () => void
  stopWaiting: () => void
}
interface Flight {
  id: number
  key: string
  request: CatalogReadRequest
  subscribers: Set<Subscriber>
}
interface WorkerState {
  transport: CatalogReadWorkerTransport
  ready: boolean
  timer?: ReturnType<typeof setTimeout>
  detach: () => void
}

function abortError(): Error {
  const error = new Error('Catalog read aborted')
  error.name = 'AbortError'
  return error
}

function normalize(query: TagOptionsQuery): Required<TagOptionsQuery> {
  const { search = '', limit = 100, offset = 0 } = query
  if (typeof search !== 'string' || search.length > 500
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid tag options query')
  // Keep original casing in the payload: lowercasing can expand a valid 500-unit query.
  return { search: search.trim(), limit, offset }
}

/** One worker, one executing query, at most 32 accepted subscribers (including coalesced reads). */
export class CatalogReadWorkerClient {
  private context?: CatalogReadContext
  private worker?: WorkerState
  private stopping?: Promise<void>
  private terminationError?: Error
  private disposed = false
  private accepted = 0
  private nextId = 0
  private flights = new Map<string, Flight>()
  private queue: Flight[] = []
  private running?: Flight
  private readonly startupTimeoutMs: number
  private readonly queryTimeoutMs: number
  private readonly queueTimeoutMs: number

  constructor(private readonly options: CatalogReadWorkerClientOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000
    this.queryTimeoutMs = options.queryTimeoutMs ?? 15_000
    this.queueTimeoutMs = options.queueTimeoutMs ?? 30_000
    for (const timeout of [this.startupTimeoutMs, this.queryTimeoutMs, this.queueTimeoutMs]) {
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) {
        throw new Error('Invalid catalog worker deadline')
      }
    }
  }

  readVideos(scope: CatalogScope, query: VideoQuery = {}, signal?: AbortSignal): Promise<ScopedVideoListResult> {
    try {
      const [identity, filters] = videoIpcSchemas[IPC.VIDEO_LIST].parse([scope, query])
      const request = {operation:'scoped-video-list' as const,scope:identity,query:filters ?? {}}
      return this.enqueue(request,[request.operation,identity,request.query],signal) as Promise<ScopedVideoListResult>
    } catch(error) { return Promise.reject(error) }
  }
  readVideoYears(scope: CatalogScope, signal?: AbortSignal): Promise<number[]> {
    try {
      const [query]=videoIpcSchemas[IPC.VIDEO_YEARS].parse([scope])
      return this.enqueue({operation:'scoped-video-years',query},['scoped-video-years',query],signal) as Promise<number[]>
    } catch(error) { return Promise.reject(error) }
  }
  readHome(input: HomeDiscoveryInput, signal?: AbortSignal): Promise<HomeSnapshot> {
    try {
      const [query]=mediaLibraryIpcSchemas[IPC.HOME_LOAD].parse([input])
      return this.enqueue({operation:'home-load',query},['home-load',query],signal) as Promise<HomeSnapshot>
    } catch(error) { return Promise.reject(error) }
  }
  searchHome(input: GlobalSearchInput, signal?: AbortSignal): Promise<GlobalSearchResult> {
    try {
      const [query]=mediaLibraryIpcSchemas[IPC.HOME_SEARCH].parse([input])
      return this.enqueue({operation:'home-search',query},['home-search',query],signal) as Promise<GlobalSearchResult>
    } catch(error) { return Promise.reject(error) }
  }
  readWebBrowse(input: WebBrowseQuery, signal?: AbortSignal): Promise<WebBrowse> {
    try {
      const query=normalizeWebBrowseQuery(input)
      return this.enqueue({operation:'web-browse',query},['web-browse',query],signal) as Promise<WebBrowse>
    } catch(error) { return Promise.reject(error) }
  }
  readWebHome(seed: string, signal?: AbortSignal): Promise<WebHome> {
    try {
      const query={seed:normalizeWebSeed(seed)}
      return this.enqueue({operation:'web-home',query},['web-home',query],signal) as Promise<WebHome>
    } catch(error) { return Promise.reject(error) }
  }
  readWebCollections(signal?: AbortSignal): Promise<WebCollections> {
    return this.enqueue({operation:'web-collections',query:{}},['web-collections'],signal) as Promise<WebCollections>
  }

  read(query: TagOptionsQuery, signal?: AbortSignal): Promise<TagFilterOptionsPage> {
    try {
      const normalized = normalize(query)
      return this.enqueue({ query: normalized }, ['tag-options', normalized.search.toLowerCase(), normalized.limit, normalized.offset], signal) as Promise<TagFilterOptionsPage>
    } catch (error) { return Promise.reject(error) }
  }

  readImageCandidates(entity: ClassificationEntityRef, query: ClassificationPageQuery = {}, signal?: AbortSignal): Promise<ClassificationListPage<ClassificationImageCandidate>> {
    try {
      if (!['organization','director','series'].includes(entity.kind) || !Number.isSafeInteger(entity.id) || entity.id <= 0) throw new Error('Invalid classification entity')
      const limit = query.limit ?? 60, offset = query.offset ?? 0
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid image candidate page')
      const identity = {kind:entity.kind, id:entity.id}
      return this.enqueue({operation:'classification-images', entity:identity, query:{limit,offset}}, ['classification-images',identity.kind,identity.id,limit,offset], signal) as Promise<ClassificationListPage<ClassificationImageCandidate>>
    } catch (error) { return Promise.reject(error) }
  }

  canRevealAuditPath(libraryId: number, filePath: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const query=normalizeAuditPathRequest(libraryId,filePath)
      return this.enqueue({operation:'scan-audit-path',query},['scan-audit-path',query],signal) as Promise<boolean>
    } catch (error) { return Promise.reject(error) }
  }

  readAuditHeader(libraryId: number, signal?: AbortSignal): Promise<ScanAuditReadHeader> {
    if (!Number.isSafeInteger(libraryId) || libraryId <= 0) return Promise.reject(new Error('Invalid audit library'))
    return this.enqueue({operation:'scan-audit-header',query:{libraryId}}, ['scan-audit-header',libraryId], signal) as Promise<ScanAuditReadHeader>
  }

  readAuditPage(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditIndexQuery, limits: ScanAuditIndexLimits, signal?: AbortSignal): Promise<ScanAuditIndexPage> {
    try {
      const request = normalizeScanAuditReadRequest(snapshot, query, limits)
      return this.enqueue({operation:'scan-audit-page', ...request}, ['scan-audit-page',request], signal) as Promise<ScanAuditIndexPage>
    } catch (error) { return Promise.reject(error) }
  }

  readAuditViewPage(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditViewQuery, limits: ScanAuditIndexLimits, signal?: AbortSignal): Promise<ScanAuditViewPage> {
    try {
      const request = normalizeScanAuditViewRequest(snapshot, query, limits)
      return this.enqueue({operation:'scan-audit-view-page', ...request}, ['scan-audit-view-page',request], signal) as Promise<ScanAuditViewPage>
    } catch (error) { return Promise.reject(error) }
  }

  // Request kind is part of the coalescing key and stays attached to the running
  // ID. Public methods narrow the trusted worker response to that request kind.
  private enqueue(request: CatalogReadRequest, requestKey: unknown[], signal?: AbortSignal): Promise<CatalogReadPage> {
    try {
      if (this.disposed) throw new Error('Catalog read client disposed')
      if (this.terminationError) throw this.terminationError
      if (signal?.aborted) throw abortError()
      const context = { ...this.options.contextProvider() }
      if (this.context && (this.context.identity !== context.identity || this.context.path !== context.path)) {
        this.fail(new Error('Catalog read context changed'))
      }
      this.context = context
      if (this.accepted >= 32) throw new Error('Catalog read capacity exceeded')
      const key = JSON.stringify([context.revision, ...requestKey])
      let flight = this.flights.get(key)
      if (!flight) {
        flight = { id: ++this.nextId, key, request, subscribers: new Set() }
        this.flights.set(key, flight)
        this.queue.push(flight)
      }
      const selected = flight
      const promise = new Promise<CatalogReadPage>((resolve, reject) => {
        let waitingTimer: ReturnType<typeof setTimeout> | undefined
        const stopWaiting = (): void => { clearTimeout(waitingTimer); waitingTimer = undefined }
        const withdraw = (error: Error): void => {
          this.settleSubscriber(selected, subscriber, error)
          if (selected.subscribers.size === 0 && selected !== this.running) {
            this.queue = this.queue.filter(item => item !== selected)
            this.forget(selected)
          }
        }
        const abort = (): void => withdraw(abortError())
        const subscriber: Subscriber = {
          resolve, reject, stopWaiting,
          cleanup: () => { stopWaiting(); signal?.removeEventListener('abort', abort) }
        }
        selected.subscribers.add(subscriber)
        this.accepted++
        signal?.addEventListener('abort', abort, { once: true })
        if (selected !== this.running) {
          waitingTimer = setTimeout(() => withdraw(new Error('Catalog worker queue timed out')), this.queueTimeoutMs)
        }
      })
      this.pump()
      return promise
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /** Rejects immediately; resolution means native worker termination has completed. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.fail(new Error('Catalog read client disposed'))
    await this.stopping
    if (this.terminationError) throw this.terminationError
  }

  private forget(flight: Flight): void {
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key)
  }

  private settleSubscriber(flight: Flight, subscriber: Subscriber, error?: Error, page?: CatalogReadPage): void {
    if (!flight.subscribers.delete(subscriber)) return
    this.accepted--
    subscriber.cleanup()
    if (error) subscriber.reject(error)
    else {
      try { subscriber.resolve(structuredClone(page!)) }
      catch (cause) { subscriber.reject(cause instanceof Error ? cause : new Error(String(cause))) }
    }
  }

  private rejectAll(error: Error): void {
    for (const flight of this.flights.values()) {
      for (const subscriber of flight.subscribers) this.settleSubscriber(flight, subscriber, error)
    }
    this.flights.clear()
    this.queue = []
    this.running = undefined
  }

  private fail(error: Error): void {
    this.rejectAll(error)
    const worker = this.worker
    if (!worker) return
    this.worker = undefined
    clearTimeout(worker.timer)
    // Keep error/exit listeners until termination settles: EventEmitter errors must stay handled.
    this.stopping = Promise.resolve().then(() => worker.transport.terminate()).then(
      () => {},
      cause => {
        this.terminationError = new Error(`Catalog worker termination failed: ${String(cause)}`)
        this.rejectAll(this.terminationError)
      }
    ).then(() => {
      worker.detach()
      this.stopping = undefined
      this.pump()
    })
  }

  private pump(): void {
    if (this.disposed || this.terminationError || this.stopping || !this.queue.length || this.running) return
    if (!this.worker) {
      try {
        const transport = this.options.transportFactory({ ...this.context! })
        const worker: WorkerState = { transport, ready: false, detach: () => {} }
        this.worker = worker
        const message = (event: CatalogReadWorkerMessage): void => {
          if (this.worker !== worker) return
          if (!event || typeof event !== 'object') {
            this.fail(new Error('Unexpected catalog worker message'))
            return
          }
          if (event.type === 'ready' && !worker.ready) {
            clearTimeout(worker.timer)
            worker.ready = true
            this.pump()
          } else if (event.type === 'result' && this.running && this.running.id === event.id) {
            clearTimeout(worker.timer)
            const flight = this.running
            this.running = undefined
            this.forget(flight)
            for (const subscriber of flight.subscribers) this.settleSubscriber(flight, subscriber, undefined, event.result)
            this.pump()
          } else if (event.type === 'error') {
            this.fail(new Error(event.message))
          } else {
            this.fail(new Error('Unexpected catalog worker message'))
          }
        }
        const error = (cause: Error): void => { if (this.worker === worker) this.fail(cause) }
        const exit = (code: number): void => {
          if (this.worker === worker) this.fail(new Error(`Unexpected catalog worker exit: ${code}`))
        }
        worker.detach = () => {
          transport.off('message', message)
          transport.off('error', error)
          transport.off('exit', exit)
        }
        transport.on('message', message)
        transport.on('error', error)
        transport.on('exit', exit)
        worker.timer = setTimeout(() => this.fail(new Error('Catalog worker startup timed out')), this.startupTimeoutMs)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
      return
    }
    if (!this.worker.ready) return
    const worker = this.worker
    const flight = this.queue.shift()!
    this.running = flight
    for (const subscriber of flight.subscribers) subscriber.stopWaiting()
    worker.timer = setTimeout(() => this.fail(new Error('Catalog worker query timed out')), this.queryTimeoutMs)
    try { worker.transport.postMessage({ type: 'read', id: flight.id, ...flight.request }) }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
  }
}
