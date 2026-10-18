import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import type { PlayGrant } from '@shared/protocol/play'

const PLAYBACK_POOL_LIMIT = 64
interface RemoteGrant { url: string; expiresAt: string }
interface GrantOptions {
  /** A playback session owns this route until release, including while paused. */
  renew?: (signal: AbortSignal) => Promise<RemoteGrant>
  signal?: AbortSignal
  external?: { key: string; grant: PlayGrant }
}
interface BridgeGrant {
  url: string
  expires: number
  renew?: GrantOptions['renew']
  renewing?: Promise<void>
  lifetime: AbortController
  requests: Set<AbortController>
  fileName: string
  external?: NonNullable<GrantOptions['external']> & { pendingOpens: number; delivered: boolean }
}
const bridgeError = (code: string, message: string): Error => Object.assign(new Error(message), { code })
const reportReadFailure = (error: unknown): void => {
  const code = (error as NodeJS.ErrnoException | null)?.code
  console.warn('[playback-bridge] media request failed', typeof code === 'string' && /^[A-Z_0-9]{1,64}$/.test(code) ? code : 'READ_FAILED')
}

/** Device-local scoped URLs for players that cannot pin a deployment TLS certificate. */
export function createPlaybackBridge(origin: string, fetchPinned: (url: string | URL, init?: RequestInit) => Promise<Response>, now = Date.now) {
  let server: Server | null = null
  let listening: Promise<number> | null = null
  let generation = 0
  let closed = false
  let cleanupTimer: ReturnType<typeof setInterval> | undefined
  const grants = new Map<string, BridgeGrant>()
  const pendingExternal = new Map<string, { promise: Promise<PlayGrant>; controller: AbortController; waiters: number }>()
  const releaseRoute = (route: string): void => {
    const grant = grants.get(route)
    if (!grant) return
    grants.delete(route)
    grant.lifetime.abort()
    for (const controller of grant.requests) controller.abort()
    grant.requests.clear()
  }
  const clear = (): void => {
    generation++
    for (const pending of pendingExternal.values()) pending.controller.abort()
    pendingExternal.clear()
    for (const route of grants.keys()) releaseRoute(route)
  }
  const prune = (): void => {
    for (const [route, grant] of grants) if (!grant.renew && grant.expires <= now()) releaseRoute(route)
  }
  const touch = (route: string, grant: BridgeGrant): void => {
    if (grants.get(route) !== grant) return
    grants.delete(route); grants.set(route, grant)
  }
  const inspectGrant = (url: string, expiresAt: string): { expires: number; fileName: string } => {
    const target = new URL(url)
    if (target.origin !== origin || !target.pathname.startsWith('/play/') || target.username || target.password)
      throw bridgeError('PLAYBACK_BRIDGE_GRANT', '播放授权地址无效')
    const expires = Date.parse(expiresAt)
    if (!Number.isFinite(expires) || expires <= now()) throw bridgeError('PLAYBACK_BRIDGE_GRANT', '播放授权已过期')
    let fileName: string
    try { fileName = decodeURIComponent(target.pathname.slice(target.pathname.lastIndexOf('/') + 1)) }
    catch { throw bridgeError('PLAYBACK_BRIDGE_GRANT', '播放授权地址无效') }
    if (!fileName || fileName === '.' || fileName === '..' || /[/\\\p{Cc}]/u.test(fileName))
      throw bridgeError('PLAYBACK_BRIDGE_GRANT', '播放授权文件名无效')
    return { expires, fileName }
  }
  const prepare = async (route: string, grant: BridgeGrant): Promise<void> => {
    if (!grant.renew || grant.expires > now() + 60_000) return
    if (!grant.renewing) {
      const pending = grant.renew(grant.lifetime.signal).then(next => {
        grant.lifetime.signal.throwIfAborted()
        if (grants.get(route) !== grant) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已变化')
        const { expires } = inspectGrant(next.url, next.expiresAt)
        grant.url = next.url; grant.expires = expires
      }).finally(() => { if (grant.renewing === pending) grant.renewing = undefined })
      grant.renewing = pending
    }
    await grant.renewing
  }
  const reusableExternal = (key: string): PlayGrant | null => {
    prune()
    for (const grant of grants.values()) {
      if (grant.external?.key === key && grant.expires > now() + 60_000) {
        return { ...grant.external.grant }
      }
    }
    return null
  }
  const routeFor = (handle: string): string | undefined => {
    const address = server?.address()
    if (!address || typeof address === 'string') return
    const prefix = `http://127.0.0.1:${address.port}`
    return handle.startsWith(`${prefix}/`) ? handle.slice(prefix.length) : undefined
  }
  const acquireExternal = (grant: PlayGrant): PlayGrant => {
    const entry = grants.get(routeFor(grant.playbackHandle) ?? '')
    if (!entry?.external) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放授权已失效，请重新播放')
    entry.external.pendingOpens++
    return { ...grant }
  }
  const discardUnusedExternal = (handle: string): void => {
    const route = routeFor(handle)
    const external = route ? grants.get(route)?.external : undefined
    if (route && external && !external.delivered && external.pendingOpens === 0) releaseRoute(route)
  }
  const bridge = {
    clear,
    async external(key: string, issue: (signal: AbortSignal) => Promise<PlayGrant>, signal?: AbortSignal): Promise<PlayGrant> {
      signal?.throwIfAborted()
      if (closed) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已关闭')
      let pending = pendingExternal.get(key)
      if (!pending || pending.controller.signal.aborted) {
        const started = generation
        const controller = new AbortController()
        const create = async (): Promise<PlayGrant> => {
          controller.signal.throwIfAborted()
          const reused = reusableExternal(key)
          if (reused) {
            const route = routeFor(reused.playbackHandle)!
            const previous = grants.get(route)!
            let response: Response | undefined
            try {
              response = await fetchPinned(previous.url, { method: 'HEAD',
                signal: AbortSignal.any([controller.signal, previous.lifetime.signal, AbortSignal.timeout(15_000)]) })
              await response.body?.cancel()
            } catch {
              controller.signal.throwIfAborted()
              if (grants.get(route) === previous) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '无法检查播放授权，请检查连接后重试')
            }
            controller.signal.throwIfAborted()
            if (closed || started !== generation) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已变化，请重新播放')
            if (response?.ok && grants.get(route) === previous && previous.external && previous.expires > now() + 60_000) {
              touch(route, previous)
              return reused
            }
            if (response && [401, 403, 404].includes(response.status)) {
              if (grants.get(route) === previous) releaseRoute(route)
            } else if (response && !response.ok) {
              throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '无法检查播放授权，请检查连接后重试')
            }
          }
          const grant = await issue(controller.signal)
          controller.signal.throwIfAborted()
          if (closed || started !== generation) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已变化，请重新播放')
          const playbackHandle = await bridge.grant(grant.playbackHandle, grant.expiresAt, { signal: controller.signal, external: { key, grant } })
          return { ...grant, playbackHandle }
        }
        const entry = { controller, waiters: 0, promise: Promise.resolve().then(create).finally(() => {
          if (pendingExternal.get(key) === entry) pendingExternal.delete(key)
        }) }
        pending = entry
        pendingExternal.set(key, entry)
      }
      const shared = pending
      shared.waiters++
      let onAbort: (() => void) | undefined
      try {
        const cancelled = new Promise<never>((_, reject) => {
          if (!signal) return
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        return acquireExternal(await Promise.race([shared.promise, cancelled]))
      } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort)
        if (--shared.waiters === 0) {
          shared.controller.abort()
          void shared.promise.then(grant => discardUnusedExternal(grant.playbackHandle)).catch(() => {})
        }
      }
    },
    finishExternal(handle: string, opened: boolean): void {
      const external = grants.get(routeFor(handle) ?? '')?.external
      if (!external) return
      external.pendingOpens = Math.max(0, external.pendingOpens - 1)
      external.delivered ||= opened
      discardUnusedExternal(handle)
    },
    release(handle: string): void {
      const route = routeFor(handle)
      if (route) releaseRoute(route)
    },
    async grant(url: string, expiresAt: string, options: GrantOptions = {}): Promise<string> {
      if (closed) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已关闭')
      const started = generation
      options.signal?.throwIfAborted()
      const { expires, fileName } = inspectGrant(url, expiresAt)
      if (!listening) {
        server = createServer((request, response) => {
          const address = server!.address()
          let route = request.url ?? ''
          const fileStart = route.indexOf('/', 1)
          if (fileStart > 0) {
            try { route = route.slice(0, fileStart + 1) + encodeURIComponent(decodeURIComponent(route.slice(fileStart + 1))) }
            catch { response.writeHead(403); response.end(); return }
          }
          const grant = grants.get(route)
          if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}` || request.headers.origin ||
            !['GET', 'HEAD'].includes(request.method ?? '') || !grant || (!grant.renew && grant.expires <= now())) { response.writeHead(403); response.end(); return }
          touch(route, grant)
          const controller = new AbortController()
          grant.requests.add(controller)
          controller.signal.addEventListener('abort', () => response.destroy(), { once: true })
          response.once('close', () => { controller.abort(); grant.requests.delete(controller) })
          const headers: Record<string, string> = {}
          for (const key of ['range', 'if-range']) { const value = request.headers[key]; if (typeof value === 'string') headers[key] = value }
          void prepare(route, grant).then(() => {
            controller.signal.throwIfAborted()
            return fetchPinned(grant.url, { method: request.method, headers, signal: controller.signal })
          }).then(remote => {
            if (controller.signal.aborted) { void remote.body?.cancel(); return }
            if (!remote.ok) console.warn('[playback-bridge] media response failed', remote.status)
            // Out-of-process revocation must not leave a reusable cached URL pointing at a dead grant.
            if ([401, 403, 404].includes(remote.status)) grant.external = undefined
            const result: Record<string, string> = {
              'Cache-Control': 'no-store',
              'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(grant.fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`
            }
            for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) { const value = remote.headers.get(key); if (value) result[key] = value }
            response.writeHead(remote.status, result)
            if (!remote.body || request.method === 'HEAD') { void remote.body?.cancel(); response.end(); return }
            const stream = Readable.fromWeb(remote.body as ReadableStream)
            stream.on('error', error => { if (!controller.signal.aborted) reportReadFailure(error); response.destroy() })
            response.once('close', () => stream.destroy())
            stream.pipe(response)
          }).catch(error => {
            if (controller.signal.aborted) return
            reportReadFailure(error)
            if (!response.headersSent) { response.writeHead(502); response.end() } else response.destroy()
          })
        })
        listening = new Promise((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(0, '127.0.0.1', () => { const address = server!.address(); if (address && typeof address !== 'string') resolve(address.port) })
        })
      }
      const port = await listening
      options.signal?.throwIfAborted()
      if (closed || started !== generation) throw bridgeError('PLAYBACK_BRIDGE_CLOSED', '播放连接已变化，请重新播放')
      prune()
      const pool = [...grants].filter(([, grant]) => Boolean(grant.renew) === Boolean(options.renew))
      if (pool.length >= PLAYBACK_POOL_LIMIT) {
        if (options.renew) throw bridgeError('PLAYBACK_BRIDGE_CAPACITY', '播放授权过多，请关闭不再使用的播放会话后重试')
        releaseRoute(pool[0][0])
      }
      const route = `/${randomBytes(32).toString('hex')}/${encodeURIComponent(fileName)}`
      const handle = `http://127.0.0.1:${port}${route}`
      grants.set(route, { url, expires, fileName, renew: options.renew, lifetime: new AbortController(), requests: new Set(),
        external: options.external ? { key: options.external.key, grant: { ...options.external.grant, playbackHandle: handle }, pendingOpens: 0, delivered: false } : undefined })
      if (!cleanupTimer) { cleanupTimer = setInterval(prune, 60_000); cleanupTimer.unref() }
      return handle
    },
    async close(): Promise<void> {
      closed = true; clear(); clearInterval(cleanupTimer)
      if (listening) await listening.catch(() => undefined)
      if (server) { const current = server; await new Promise<void>(resolve => { current.close(() => resolve()); current.closeAllConnections() }); server = null; listening = null }
    }
  }
  return bridge
}
