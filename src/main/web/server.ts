import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { WebCatalogReader } from './catalog'
import { LoginLimiter, verifyPassword, WebSessions, WebPairing } from './auth'
import { json, readJson, sendFile, WebError } from './http'

const COOKIE = 'javdex_web_session'
export function isLocalPeer(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  return isIP(ip) === 6 && (ip === '::1' || /^(fc|fd|fe[89ab])/i.test(ip))
}
export function localAddresses(): string[] {
  return [
    ...new Set([
      '127.0.0.1',
      ...Object.values(networkInterfaces()).flatMap((items) =>
        (items ?? [])
          .filter(
            (item) =>
              item.family === 'IPv4' &&
              !item.internal &&
              isLocalPeer(item.address)
          )
          .map((item) => item.address)
      )
    ])
  ]
}
function token(request: IncomingMessage): string {
  const match = request.headers.cookie
    ?.split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${COOKIE}=`))
  return match?.slice(COOKIE.length + 1) ?? ''
}
function cookie(value: string, expire = false, remember = false): string {
  // Direct LAN HTTP cannot use Secure; HTTPS termination is deliberately not trusted implicitly.
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/${expire || remember ? `; Max-Age=${expire ? 0 : 7 * 86400}` : ''}`
}
export class WebServer {
  private server: Server | null = null
  private epoch = 0
  private responses = new Map<string, Set<ServerResponse>>()
  // Brief delivery cache: retries receive the same session, never a second authorization.
  private deliveries = new Map<
    string,
    { token: string; remember: boolean; expires: number }
  >()
  private deliveryKey(secret: string): string {
    return createHash('sha256').update(secret).digest('hex')
  }
  private pruneDeliveries(): void {
    for (const [key, item] of this.deliveries)
      if (item.expires <= Date.now()) this.deliveries.delete(key)
  }
  private closeDevice(id: string | undefined): void {
    if (id)
      for (const response of this.responses.get(id) ?? []) response.destroy()
  }
  private track(tokenValue: string, response: ServerResponse): void {
    const id = this.sessions.idFor(tokenValue)
    if (!id) return
    const pending = this.responses.get(id) ?? new Set<ServerResponse>()
    pending.add(response)
    this.responses.set(id, pending)
    const done = (): void => {
      pending.delete(response)
      if (!pending.size) this.responses.delete(id)
    }
    response.once('close', done)
    response.once('finish', done)
  }
  readonly pairing = new WebPairing()
  private sessions: WebSessions
  private pairLimiter = new LoginLimiter()
  private limiter = new LoginLimiter()
  constructor(
    private readonly options: {
      username: string
      passwordHash: string
      staticRoot: string
      catalog: WebCatalogReader
      sessions?: WebSessions
    }
  ) {
    this.sessions = options.sessions ?? new WebSessions()
  }
  get sessionCount(): number {
    return this.sessions.count()
  }
  get devices() {
    return this.sessions.list()
  }
  removeDevice(id: string): void {
    this.sessions.remove(id)
    this.closeDevice(id)
  }
  revokeSessions(): void {
    this.sessions.clear()
    this.epoch++
    this.deliveries.clear()
    this.pairing.clear()
    this.server?.closeAllConnections()
  }
  async start(port: number, host = '0.0.0.0'): Promise<number> {
    if (this.server) throw new Error('Web 服务已启动')
    const server = createServer(
      { maxHeaderSize: 8192, requestTimeout: 15_000, headersTimeout: 10_000 },
      (req, res) => {
        void this.handle(req, res).catch((error) => {
          if (res.destroyed) return
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.removeHeader('Content-Length')
          json(res, error instanceof WebError ? error.status : 404, {
            error:
              error instanceof WebError
                ? error.message
                : '内容暂不可用，请稍后重试'
          })
        })
      }
    )
    server.maxConnections = 128
    server.keepAliveTimeout = 5000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    // Runtime socket failures must not crash the desktop application.
    server.on('error', () => {
      this.sessions.clear()
    })
    return (server.address() as { port: number }).port
  }
  async stop(): Promise<void> {
    this.epoch++
    this.deliveries.clear()
    this.pairing.clear()
    const server = this.server
    this.server = null
    try {
      this.sessions.suspend()
    } finally {
      if (server)
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const epoch = this.epoch
    const ensureActive = (): void => {
      if (epoch !== this.epoch || !this.server)
        throw new WebError(503, '服务已切换，请重新登录')
    }
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' http: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    if (!isLocalPeer(request.socket.remoteAddress ?? ''))
      throw new WebError(403, '仅允许局域网访问')
    const authority = request.headers.host ?? ''
    const port = request.socket.localPort
    // Literal local hosts only: prevents DNS rebinding and ignores forwarded headers.
    if (
      !new Set(
        [...localAddresses(), 'localhost'].map((host) => `${host}:${port}`)
      ).has(authority)
    )
      throw new WebError(403, '访问地址无效，请使用桌面端显示的地址')
    if (request.headers['sec-fetch-site'] === 'cross-site')
      throw new WebError(403, '不允许跨站请求')
    if (
      request.headers.origin &&
      request.headers.origin !== `http://${authority}`
    )
      throw new WebError(403, '不允许跨站请求')
    const url = new URL(request.url ?? '/', `http://${authority}`)
    if (url.origin !== `http://${authority}`)
      throw new WebError(400, '请求地址无效')
    const method = request.method ?? 'GET'
    if (method === 'POST') {
      if (
        request.headers.origin !== `http://${authority}` ||
        request.headers['x-javdex-client'] !== 'web'
      )
        throw new WebError(403, '请求来源无效')
      this.pruneDeliveries()
      if (url.pathname === '/api/pair/start') {
        const release = this.pairLimiter.enter(
          request.socket.remoteAddress ?? ''
        )
        if (!release) throw new WebError(429, '配对请求过于频繁，请稍后重试')
        try {
          const body = await readJson(request)
          ensureActive()
          const name = `${String(body.name || '浏览器').slice(0, 50)} · ${request.socket.remoteAddress}`
          const pair = this.pairing.create(body.remember === true, name)
          response.setHeader(
            'Set-Cookie',
            `javdex_pair=${pair.secret}; HttpOnly; SameSite=Strict; Path=/api/pair; Max-Age=300`
          )
          json(response, 200, {
            ...this.pairing.status(pair.secret),
            expires: pair.expires
          })
        } catch (error) {
          throw new WebError(400, (error as Error).message)
        } finally {
          release()
        }
        return
      }
      if (
        url.pathname === '/api/pair/poll' ||
        url.pathname === '/api/pair/cancel' ||
        url.pathname === '/api/pair/status'
      ) {
        await readJson(request)
        ensureActive()
        const secret =
          request.headers.cookie
            ?.split(';')
            .map((x) => x.trim())
            .find((x) => x.startsWith('javdex_pair='))
            ?.slice(12) ?? ''
        const key = this.deliveryKey(secret)
        const delivered = this.deliveries.get(key)
        if (url.pathname === '/api/pair/cancel') {
          if (delivered) {
            const id = this.sessions.idFor(delivered.token)
            this.sessions.revoke(delivered.token)
            this.closeDevice(id)
            this.deliveries.delete(key)
          }
          this.pairing.cancel(secret)
          response.setHeader(
            'Set-Cookie',
            'javdex_pair=; HttpOnly; SameSite=Strict; Path=/api/pair; Max-Age=0'
          )
          json(response, 200, { cancelled: true })
          return
        }
        try {
          if (delivered) {
            if (!this.sessions.check(delivered.token))
              throw new WebError(410, '授权已撤销，请重新配对')
            response.setHeader(
              'Set-Cookie',
              cookie(delivered.token, false, delivered.remember)
            )
            json(response, 200, {
              authenticated: true,
              username: this.options.username
            })
            return
          }
          if (url.pathname === '/api/pair/status') {
            json(response, 200, this.pairing.status(secret))
            return
          }
          const state = this.pairing.status(secret)
          let value = ''
          const paired = this.pairing.poll(secret, (row) => {
            value = this.sessions.create(row.remember, row.name)
          })
          if (!paired) {
            json(response, 200, { ...state, authenticated: false })
            return
          }
          // Keep only for the bounded response-delivery window; revoke invalidates retries.
          const delivery = {
            token: value,
            remember: paired.remember,
            expires: Math.min(paired.expires, Date.now() + 60_000)
          }
          this.deliveries.set(key, delivery)
          setTimeout(
            () => {
              if (this.deliveries.get(key) === delivery)
                this.deliveries.delete(key)
            },
            Math.max(0, delivery.expires - Date.now())
          ).unref()
          this.pairing.connected(paired.code, paired.name)
          response.setHeader(
            'Set-Cookie',
            cookie(value, false, paired.remember)
          )
          json(response, 200, {
            authenticated: true,
            username: this.options.username
          })
        } catch (error) {
          if (error instanceof WebError) throw error
          if ((error as Error).message.startsWith('设备记录保存失败'))
            throw new WebError(503, (error as Error).message)
          if ((error as Error).message === '请稍后查询配对结果') {
            response.setHeader('Retry-After', '5')
            throw new WebError(429, '请稍后查询配对结果')
          }
          throw new WebError(410, (error as Error).message)
        }
        return
      }
      if (url.pathname === '/api/login') {
        const release = this.limiter.enter(request.socket.remoteAddress ?? '')
        if (!release) {
          response.setHeader('Retry-After', '900')
          throw new WebError(429, '尝试过于频繁，请 15 分钟后重试')
        }
        try {
          const body = await readJson(request)
          ensureActive()
          if (
            typeof body.username !== 'string' ||
            typeof body.password !== 'string' ||
            body.password.length > 128
          )
            throw new WebError(400, '请填写账号和密码')
          const valid = await verifyPassword(
            body.password,
            this.options.passwordHash
          )
          ensureActive()
          if (!valid || body.username !== this.options.username)
            throw new WebError(401, '账号或密码错误')
          this.sessions.revoke(token(request))
          response.setHeader(
            'Set-Cookie',
            cookie(
              this.sessions.create(
                body.remember === true,
                String(
                  body.name || request.headers['user-agent'] || '浏览器'
                ).slice(0, 80)
              ),
              false,
              body.remember === true
            )
          )
          json(response, 200, {
            authenticated: true,
            username: this.options.username
          })
        } finally {
          release()
        }
        return
      }
      if (url.pathname === '/api/logout') {
        const id = this.sessions.idFor(token(request))
        this.sessions.revoke(token(request))
        this.closeDevice(id)
        response.setHeader('Set-Cookie', cookie('', true))
        json(response, 200, { authenticated: false })
        return
      }
      throw new WebError(405, 'Web 端仅提供只读浏览')
    }
    if (!['GET', 'HEAD'].includes(method))
      throw new WebError(405, 'Web 端仅提供只读浏览')
    if (url.pathname.startsWith('/api/')) {
      if (!this.sessions.check(token(request)))
        throw new WebError(401, '请先登录')
      this.track(token(request), response)
      if (url.pathname === '/api/session') {
        json(response, 200, {
          authenticated: true,
          username: this.options.username
        })
        return
      }
      if (url.pathname === '/api/collections') {
        json(response, 200, this.options.catalog.collections())
        return
      }
      if (url.pathname === '/api/videos') {
        json(response, 200, this.options.catalog.browse(url.searchParams))
        return
      }
      const match =
        /^\/api\/videos\/([1-9]\d{0,9})(?:\/(images|media)\/(cover|[1-9]\d{0,9}))?$/.exec(
          url.pathname
        )
      if (!match) throw new WebError(404, '页面不存在')
      const id = Number(match[1])
      if (!match[2]) {
        json(response, 200, this.options.catalog.detail(id))
        return
      }
      if (match[2] === 'images') {
        const image = this.options.catalog.image(id, match[3])
        response.setHeader('Content-Type', image.mime)
        response.setHeader('Content-Length', image.body.length)
        response.end(method === 'HEAD' ? undefined : image.body)
        return
      }
      const media = this.options.catalog.media(id, Number(match[3]))
      if ('redirect' in media) {
        response.writeHead(302, { Location: media.redirect! })
        response.end()
        return
      }
      await sendFile(request, response, media.file, media.mime, media.stat)
      return
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    // Vite output only. No source tree, arbitrary paths, maps, or Electron renderer assets.
    if (file !== 'index.html' && !/^assets\/[\w.-]+\.(js|css)$/.test(file))
      throw new WebError(404, '页面不存在')
    const mime = file.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : file.endsWith('.css')
        ? 'text/css; charset=utf-8'
        : 'text/html; charset=utf-8'
    await sendFile(
      request,
      response,
      path.join(this.options.staticRoot, file),
      mime
    )
  }
}
