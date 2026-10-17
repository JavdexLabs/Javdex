import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http, { type IncomingMessage, type IncomingHttpHeaders } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { gatewayRequestAllowed, gatewayRouteAllowed, cleanProxyHeaders, proxyBusiness } from './gateway'
import { gatewayContext, httpBrowserOrigin } from '@http/gatewayPeer'
import { WebServer } from '@http/server'
import { hashPassword } from '@http/auth'
import { createDualProtocolServer } from './dualProtocolServer'

test('gateway trusts only authenticated protocol metadata and validates the actual origin', () => {
  const origin = 'https://library.local:8096'
  const request = { method: 'POST', url: '/manage/v1/handshake.get', headers: { host: 'library.local:8096', origin }, socket: { remoteAddress: '192.168.1.5', encrypted: true } } as unknown as IncomingMessage
  assert.equal(gatewayRequestAllowed(request, origin), true)
  assert.equal(gatewayRequestAllowed({ ...request, headers: { ...request.headers, host: 'evil.local' } } as IncomingMessage, origin), false)
  assert.equal(gatewayRequestAllowed({ ...request, headers: { ...request.headers, origin: 'https://evil.local' } } as IncomingMessage, origin), false)
  assert.equal(gatewayRequestAllowed({ ...request, url: '//evil.local/' } as IncomingMessage, origin), false)
  const plain = { ...request, socket: { remoteAddress: '192.168.1.5' }, headers: { host: 'library.local:8096', origin: 'http://library.local:8096' } } as unknown as IncomingMessage
  assert.equal(gatewayRequestAllowed(plain, origin), true)
  assert.equal(gatewayRequestAllowed({ ...plain, headers: request.headers } as IncomingMessage, origin), false)
  assert.equal(gatewayRouteAllowed(plain), false)
  const config = { origin, token: 'd'.repeat(64) }
  assert.equal(gatewayContext(request, config), null)
  const internal = { headers: { 'x-javdex-gateway': config.token, 'x-javdex-peer': '192.168.1.5', 'x-javdex-gateway-protocol': 'http' }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
  assert.deepEqual(gatewayContext(internal, config), { peer: '192.168.1.5', protocol: 'http', origin: 'http://library.local:8096' })
  for (const headers of [
    { ...internal.headers, 'x-javdex-gateway': 'x'.repeat(64) },
    { ...internal.headers, 'x-javdex-gateway': 'é'.repeat(64) },
    { ...internal.headers, 'x-javdex-gateway-protocol': undefined },
    { ...internal.headers, 'x-javdex-gateway-protocol': 'ftp' }
  ]) assert.equal(gatewayContext({ ...internal, headers } as unknown as IncomingMessage, config), null)
  assert.deepEqual(cleanProxyHeaders({ connection: 'X-Remove', 'x-remove': 'secret', authorization: 'Bearer writer', 'x-javdex-peer': '127.0.0.1', 'x-javdex-gateway-protocol': 'https', forwarded: 'proto=https', 'x-forwarded-proto': 'https' }), { authorization: 'Bearer writer' })
  assert.equal(httpBrowserOrigin('https://nas.local'), 'http://nas.local:443')
  assert.equal(httpBrowserOrigin('https://nas.local:80'), 'http://nas.local')
  assert.equal(httpBrowserOrigin('https://[fd00::1]:8096'), 'http://[fd00::1]:8096')
})

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-dual-gateway-'))
const movie = path.join(directory, 'movie.mp4')
const token = 'd'.repeat(64)
let business: WebServer
let gateway: ReturnType<typeof createDualProtocolServer>
let port: number
let businessPort: number
let managerRequests = 0
let manageRequests = 0

type Reply = { status: number; headers: IncomingHttpHeaders; body: string }
function send(protocol: 'http' | 'https', pathname: string, options: { method?: string; headers?: http.OutgoingHttpHeaders; body?: unknown; port?: number } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = (protocol === 'https' ? https : http).request({ hostname: '127.0.0.1', port: options.port ?? port, path: pathname,
      method: options.method ?? 'GET', rejectUnauthorized: false, agent: false,
      headers: { Host: `127.0.0.1:${port}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
    })
    request.setTimeout(5000, () => request.destroy(new Error('request timeout')))
    request.once('error', reject)
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body))
  })
}
function post(protocol: 'http' | 'https', pathname: string, body: unknown, cookie?: string): Promise<Reply> {
  return send(protocol, pathname, { method: 'POST', body, headers: { Origin: `${protocol}://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-Javdex-Client': 'web', ...(cookie ? { Cookie: cookie } : {}) } })
}
function sharedCookie(reply: Reply): string {
  assert.equal(reply.status, 200, reply.body)
  const value = reply.headers['set-cookie']?.[0]
  assert.ok(value)
  assert.match(value, /HttpOnly; SameSite=Strict; Path=/)
  assert.doesNotMatch(value, /;\s*Secure(?:;|$)/i)
  return value.split(';')[0]
}

before(async () => {
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=test', '-keyout', key, '-out', cert], { stdio: 'ignore' })
  fs.writeFileSync(movie, '0123456789abcdef')
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Web</title>')
  const config = { origin: '', token }
  gateway = createDualProtocolServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    if (!gatewayRequestAllowed(request, config.origin) || !gatewayRouteAllowed(request)) { response.writeHead(403); response.end(); return }
    if (/^\/(runtime|connect|update)\//.test(request.url!)) { managerRequests++; response.end('manager'); return }
    proxyBusiness(request, response, `http://127.0.0.1:${businessPort}`, `127.0.0.1:${businessPort}`, config)
  })
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const address = gateway.address(); assert.ok(address && typeof address !== 'string')
  port = address.port
  config.origin = `https://127.0.0.1:${port}`
  business = new WebServer({ username: 'viewer', passwordHash: await hashPassword('correct horse battery'), staticRoot: directory, gateway: config,
    catalog: { home: () => ({ discovery: [], recent: [] }), collections: () => ({ libraries: [], playlists: [] }),
      browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }), detail: () => { throw new Error('not found') },
      image: async () => ({ body: Buffer.from('image'), mime: 'image/png' }),
      media: () => ({ file: movie, stat: fs.statSync(movie), mime: 'video/mp4' }) },
    manage: { appVersion: '0.9.0', dispatch: context => { manageRequests++; return { isLoopback: context.isLoopback, bearer: context.bearerSecret } } },
    probes: { live: () => ({ status: 'ok' }), ready: () => ({ ready: true }) }
  })
  businessPort = await business.start(0, '127.0.0.1')
})

after(async () => {
  if (gateway) { const closed = new Promise<void>(resolve => gateway.close(() => resolve())); gateway.closeAllConnections(); await closed }
  await business?.stop()
  fs.rmSync(directory, { recursive: true, force: true })
})

test('one port serves both schemes; shared Web sessions renew, stream and log out across schemes', async () => {
  for (const protocol of ['http', 'https'] as const) {
    assert.equal((await send(protocol, '/')).status, 200)
    const loggedIn = await post(protocol, '/api/login', { username: 'viewer', password: 'correct horse battery', remember: true })
    const cookie = sharedCookie(loggedIn)
    assert.match(loggedIn.headers['set-cookie']![0], /Max-Age=31536000/)
    const other = protocol === 'http' ? 'https' : 'http'
    const renewed = await send(other, '/api/session', { headers: { Cookie: cookie } })
    assert.equal(sharedCookie(renewed), cookie)
    const media = await send(other, '/api/videos/1/media/1', { headers: { Cookie: cookie, Range: 'bytes=1-3' } })
    assert.equal(media.status, 206); assert.equal(media.body, '123'); assert.equal(media.headers['content-range'], 'bytes 1-3/16')
    const head = await send(protocol, '/api/videos/1/media/1', { method: 'HEAD', headers: { Cookie: cookie, Range: 'bytes=1-3' } })
    assert.equal(head.status, 206); assert.equal(head.body, '')
    assert.equal((await send(other, '/api/videos/1/media/1?download=1', { headers: { Cookie: cookie } })).headers['content-disposition']?.startsWith('attachment;'), true)
    sharedCookie(await post(other, '/api/logout', {}, cookie))
    assert.equal((await send(protocol, '/api/session', { headers: { Cookie: cookie } })).status, 401)
  }
})

test('HTTP blocks client routes and forged TLS headers, with a second guard inside the business server', async () => {
  const routes = ['/manage/v1/handshake.get', '/manage/v1/writer.%72ecoverIssue', '/connect/v1/claim', '/update/v1/control', '/runtime/v1/info', '/play/v1/file?t=valid', '/live', '/ready', '/%6danage/v1/handshake.get', '/api/../manage/v1/handshake.get']
  const headers = { Authorization: `Bearer ${'a'.repeat(64)}`, 'X-Javdex-Gateway': token, 'X-Javdex-Gateway-Protocol': 'https', 'X-Javdex-Peer': '127.0.0.1', 'X-Forwarded-Proto': 'https' }
  const previousManager = managerRequests, previousManage = manageRequests
  for (const route of routes) assert.equal((await send('http', route, { method: route.includes('manage') || route.includes('claim') || route.includes('control') ? 'POST' : 'GET', headers, body: {} })).status, 403, route)
  assert.equal(managerRequests, previousManager); assert.equal(manageRequests, previousManage)
  const management = await send('https', '/manage/v1/handshake.get', { method: 'POST', headers, body: {} })
  assert.equal(management.status, 200, management.body)
  assert.deepEqual(JSON.parse(management.body), { isLoopback: false, bearer: 'a'.repeat(64) })
  for (const route of ['/runtime/v1/info', '/update/v1/control', '/connect/v1/claim', '/live', '/ready']) assert.equal((await send('https', route)).status, 200, route)
  for (const route of ['/manage/v1/writer.recoverIssue', '/manage/v1/writer.%72ecoverIssue']) assert.equal((await send('https', route, { method: 'POST' })).status, 403)
  const forwarded = { 'X-Javdex-Gateway': token, 'X-Javdex-Peer': '192.168.1.5', 'X-Javdex-Gateway-Protocol': 'http', Host: `127.0.0.1:${businessPort}` }
  for (const route of routes.slice(0, 8)) assert.equal((await send('http', route, { port: businessPort, headers: forwarded })).status, 403, route)
  assert.equal((await send('http', '/api/session', { port: businessPort, headers: { ...forwarded, 'X-Javdex-Gateway-Protocol': 'ftp' } })).status, 403)
  assert.equal((await send('http', '/api/session', { headers: { Origin: `https://127.0.0.1:${port}` } })).status, 403)
})

test('browser pairing cookie and resulting session work across HTTP and HTTPS', async () => {
  business.pairing.open()
  const started = await post('https', '/api/pair/start', { name: 'browser', remember: true })
  const pairCookie = sharedCookie(started)
  const code = JSON.parse(started.body).code
  const status = await post('http', '/api/pair/status', {}, pairCookie)
  assert.equal(status.status, 200); assert.equal(JSON.parse(status.body).code, code)
  business.pairing.decide(code, true)
  const cookie = sharedCookie(await post('http', '/api/pair/poll', {}, pairCookie))
  assert.equal((await send('https', '/api/session', { headers: { Cookie: cookie } })).status, 200)
  sharedCookie(await post('https', '/api/pair/cancel', {}, pairCookie))
  assert.equal((await send('http', '/api/session', { headers: { Cookie: cookie } })).status, 401)
})

test('protocol prefixes can arrive in fragments; shutdown closes sockets awaiting a prefix or TLS handshake', async () => {
  const relaySockets = new Set<net.Socket>()
  const relay = net.createServer(client => {
    const upstream = net.connect(port, '127.0.0.1')
    for (const socket of [client, upstream]) { relaySockets.add(socket); socket.on('error', () => {}); socket.on('close', () => relaySockets.delete(socket)) }
    upstream.pipe(client)
    client.once('data', chunk => {
      upstream.write(chunk.subarray(0, 1))
      setTimeout(() => { upstream.write(chunk.subarray(1)); client.pipe(upstream) }, 10)
    })
  })
  await new Promise<void>(resolve => relay.listen(0, '127.0.0.1', resolve))
  const address = relay.address(); assert.ok(address && typeof address !== 'string')
  try { for (const protocol of ['http', 'https'] as const) assert.equal((await send(protocol, '/', { port: address.port })).status, 200) }
  finally { const closed = new Promise<void>(resolve => relay.close(() => resolve())); for (const socket of relaySockets) socket.destroy(); await closed }
  const idle = net.connect(port, '127.0.0.1'), handshake = net.connect(port, '127.0.0.1')
  for (const socket of [idle, handshake]) socket.on('error', (error: NodeJS.ErrnoException) => assert.equal(error.code, 'ECONNRESET', 'only the intentional shutdown reset is expected'))
  await Promise.all([idle, handshake].map(socket => new Promise<void>(resolve => socket.once('connect', resolve))))
  handshake.write(Buffer.from([0x16]))
  const closed = Promise.all([idle, handshake].map(socket => new Promise<void>(resolve => socket.once('close', () => resolve()))))
  gateway.closeAllConnections()
  await closed
})
