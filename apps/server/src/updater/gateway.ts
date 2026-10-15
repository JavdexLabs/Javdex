import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { isLocalPeer, type GatewayConfig } from '@http/gatewayPeer'

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
export function cleanProxyHeaders(headers: http.IncomingHttpHeaders): http.IncomingHttpHeaders {
  const blocked = new Set([...hop, ...(headers.connection ?? '').split(',').map(v => v.trim().toLowerCase())])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key) && !key.startsWith('x-javdex-gateway') && key !== 'x-javdex-peer' && !key.startsWith('x-forwarded-') && key !== 'forwarded'))
}
export function gatewayRequestAllowed(request: IncomingMessage, origin: string): boolean {
  return isLocalPeer(request.socket.remoteAddress ?? '') && request.headers.host === new URL(origin).host &&
    (!request.headers.origin || request.headers.origin === origin) && request.headers['sec-fetch-site'] !== 'cross-site' &&
    Boolean(request.url?.startsWith('/') && !request.url.startsWith('//'))
}
/** Fixed loopback upstream only. Bodies and Range responses are streamed, never buffered. */
export function proxyBusiness(request: IncomingMessage, response: ServerResponse, upstream: string, healthHost: string, gateway: GatewayConfig): void {
  // Also fail closed when an older business release is running during rollback.
  const pathname = new URL(request.url ?? '/', gateway.origin).pathname
  let decoded: string
  try { decoded = decodeURIComponent(pathname) } catch { response.writeHead(400); response.end(); return }
  if (decoded === '/manage/v1/writer.recoverIssue') { response.writeHead(403); response.end(); return }
  const headers = cleanProxyHeaders(request.headers)
  headers.host = healthHost
  headers['x-javdex-gateway'] = gateway.token
  headers['x-javdex-peer'] = request.socket.remoteAddress ?? ''
  const target = new URL(upstream)
  const outgoing = http.request({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers }, incoming => {
    const result = cleanProxyHeaders(incoming.headers)
    if (result['set-cookie']) result['set-cookie'] = result['set-cookie'].map(value => `${value}; Secure`)
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
