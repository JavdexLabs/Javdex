import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'

/** Device-local scoped URLs for players that cannot pin a deployment TLS certificate. */
export function createPlaybackBridge(origin: string, fetchPinned: (url: string | URL, init?: RequestInit) => Promise<Response>) {
  let server: Server | null = null
  let listening: Promise<number> | null = null
  let generation = 0
  let closed = false
  const grants = new Map<string, { url: string; expires: number }>()
  const active = new Set<AbortController>()
  const clear = (): void => { generation++; grants.clear(); for (const controller of active) controller.abort(); active.clear() }
  return {
    clear,
    async grant(url: string, expiresAt: string): Promise<string> {
      if (closed) throw new Error('播放连接已关闭')
      const started = generation
      const target = new URL(url)
      if (target.origin !== origin || !target.pathname.startsWith('/play/') || target.username || target.password) throw new Error('播放授权地址无效')
      const expires = Date.parse(expiresAt)
      if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('播放授权已过期')
      if (!listening) {
        server = createServer((request, response) => {
          const controller = new AbortController()
          active.add(controller)
          response.once('close', () => { controller.abort(); active.delete(controller) })
          const address = server!.address()
          const grant = grants.get(request.url ?? '')
          if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}` || request.headers.origin ||
            !['GET', 'HEAD'].includes(request.method ?? '') || !grant || grant.expires <= Date.now()) { response.writeHead(403); response.end(); return }
          const headers: Record<string, string> = {}
          for (const key of ['range', 'if-range']) { const value = request.headers[key]; if (typeof value === 'string') headers[key] = value }
          void fetchPinned(grant.url, { method: request.method, headers, signal: controller.signal }).then(remote => {
            if (controller.signal.aborted) { void remote.body?.cancel(); return }
            const result: Record<string, string> = { 'Cache-Control': 'no-store' }
            for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) { const value = remote.headers.get(key); if (value) result[key] = value }
            response.writeHead(remote.status, result)
            if (!remote.body || request.method === 'HEAD') { void remote.body?.cancel(); response.end(); return }
            const stream = Readable.fromWeb(remote.body as ReadableStream)
            stream.on('error', () => response.destroy())
            response.once('close', () => stream.destroy())
            stream.pipe(response)
          }).catch(() => { if (!response.headersSent) { response.writeHead(502); response.end() } else response.destroy() })
        })
        listening = new Promise((resolve, reject) => {
          server!.once('error', reject)
          server!.listen(0, '127.0.0.1', () => { const address = server!.address(); if (address && typeof address !== 'string') resolve(address.port) })
        })
      }
      const port = await listening
      if (closed || started !== generation) throw new Error('播放连接已变化，请重新播放')
      for (const [key, grant] of grants) if (grant.expires <= Date.now()) grants.delete(key)
      if (grants.size >= 128) throw new Error('播放授权过多，请重新连接后重试')
      const route = `/${randomBytes(32).toString('hex')}`
      grants.set(route, { url, expires })
      return `http://127.0.0.1:${port}${route}`
    },
    async close(): Promise<void> {
      closed = true; clear()
      if (listening) await listening.catch(() => undefined)
      if (server) { const current = server; await new Promise<void>(resolve => { current.close(() => resolve()); current.closeAllConnections() }); server = null; listening = null }
    }
  }
}
