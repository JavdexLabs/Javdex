import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { httpBrowserOrigin, isLocalPeer, type GatewayConfig } from '@http/gatewayPeer'
import { isBrowserRequest } from '@http/browserRoutes'

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function cleanProxyHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const blocked = new Set([...hop, ...(headers.connection ?? '').split(',').map(v => v.trim().toLowerCase())])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key) && !key.startsWith('x-javdex-gateway') && key !== 'x-javdex-peer' && !key.startsWith('x-forwarded-') && key !== 'forwarded'))
}
export function gatewayRequestAllowed(request: IncomingMessage, origin: string): boolean {
  const requestOrigin = isSecureRequest(request) ? origin : httpBrowserOrigin(origin)
  return isLocalPeer(request.socket.remoteAddress ?? '') && request.headers.host === new URL(requestOrigin).host &&
    (!request.headers.origin || request.headers.origin === requestOrigin) && request.headers['sec-fetch-site'] !== 'cross-site' &&
    Boolean(request.url?.startsWith('/') && !request.url.startsWith('//'))
}
export function isSecureRequest(request: IncomingMessage): boolean {
  return (request.socket as TLSSocket).encrypted === true
}
/** Used before manager dispatch as well as at the business proxy boundary. */
export function gatewayRouteAllowed(request: IncomingMessage): boolean {
  return isSecureRequest(request) || isBrowserRequest(request.method ?? 'GET', new URL(request.url ?? '/', 'http://gateway.invalid').pathname)
}
/** Fixed loopback upstream only. Bodies and Range responses are streamed, never buffered. */
export function proxyBusiness(request: IncomingMessage, response: ServerResponse, upstream: string, healthHost: string, gateway: GatewayConfig): void {
  if (!gatewayRouteAllowed(request)) { response.writeHead(403); response.end('此接口仅支持 HTTPS'); return }
  // Also fail closed when an older business release is running during rollback.
  const pathname = new URL(request.url ?? '/', gateway.origin).pathname
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { response.writeHead(400); response.end(); return }
  if (decoded === '/manage/v1/writer.recoverIssue') { response.writeHead(403); response.end(); return }
  const headers = cleanProxyHeaders(request.headers)
  headers.host = healthHost
  headers['x-javdex-gateway'] = gateway.token
  headers['x-javdex-peer'] = request.socket.remoteAddress ?? ''
  headers['x-javdex-gateway-protocol'] = isSecureRequest(request) ? 'https' : 'http'
  const target = new URL(upstream)
  const outgoing = http.request({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers }, incoming => {
    const result = cleanProxyHeaders(incoming.headers)
    response.writeHead(incoming.statusCode ?? 502, result)
    incoming.on('error', () => response.destroy())
    incoming.pipe(response)
    response.once('close', () => incoming.destroy())
  })
  outgoing.setTimeout(120_000, () => outgoing.destroy())
  outgoing.on('error', () => { if (!response.headersSent) { response.writeHead(503, { 'Cache-Control': 'no-store' }); response.end('服务暂不可用，更新入口仍可访问') } else response.destroy() })
  request.once('aborted', () => outgoing.destroy())
  response.once('close', () => outgoing.destroy())
  request.pipe(outgoing)
}
