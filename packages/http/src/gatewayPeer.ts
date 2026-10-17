import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export interface GatewayConfig { origin: string; token: string }
export interface GatewayContext { peer: string; protocol: 'http' | 'https'; origin: string }

/** Preserve the public port, including HTTPS's implicit 443, when changing scheme. */
export function httpBrowserOrigin(httpsOrigin: string): string {
  const url = new URL(httpsOrigin)
  const port = url.port || '443'
  url.protocol = 'http:'
  url.port = port
  return url.origin
}
export function isLocalPeer(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return isIP(ip) === 6 && (ip === '::1' || /^(fc|fd|fe[89ab])/i.test(ip))
}
export function gatewayContext(request: IncomingMessage, config?: GatewayConfig): GatewayContext | null {
  if (!config || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return null
  const token = request.headers['x-javdex-gateway']
  const peer = request.headers['x-javdex-peer']
  const protocol = request.headers['x-javdex-gateway-protocol']
  if (typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(config.token) ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(config.token)) || typeof peer !== 'string' || !isIP(peer) ||
    (protocol !== 'http' && protocol !== 'https')) return null
  return { peer, protocol, origin: protocol === 'https' ? config.origin : httpBrowserOrigin(config.origin) }
}
