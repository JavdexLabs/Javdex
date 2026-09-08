import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import path from 'node:path'
import type { WebCatalogReader } from './catalog'
import { LoginLimiter, verifyPassword, WebSessions } from './auth'
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
function cookie(value: string, expire = false): string {
  // Direct LAN HTTP cannot use Secure; HTTPS termination is deliberately not trusted implicitly.
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${expire ? 0 : 7 * 86400}`
}
export class WebServer {
  private server: Server | null = null
  private sessions = new WebSessions()
  private limiter = new LoginLimiter()
  constructor(
    private readonly options: {
      username: string
      passwordHash: string
      staticRoot: string
      catalog: WebCatalogReader
    }
  ) {}
  get sessionCount(): number {
    return this.sessions.count()
  }
  revokeSessions(): void {
    this.sessions.clear()
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
    this.sessions.clear()
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
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
      if (url.pathname === '/api/login') {
        const release = this.limiter.enter(request.socket.remoteAddress ?? '')
        if (!release) {
          response.setHeader('Retry-After', '900')
          throw new WebError(429, '尝试过于频繁，请 15 分钟后重试')
        }
        try {
          const body = await readJson(request)
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
          if (!valid || body.username !== this.options.username)
            throw new WebError(401, '账号或密码错误')
          this.sessions.revoke(token(request))
          response.setHeader('Set-Cookie', cookie(this.sessions.create()))
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
        this.sessions.revoke(token(request))
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
