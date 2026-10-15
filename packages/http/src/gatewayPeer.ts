import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'

export interface GatewayConfig { origin: string; token: string }
export function isLocalPeer(address: string): boolean {
  const ip = address.replace(/^::ffff:/, '')
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  }
  return isIP(ip) === 6 && (ip === '::1' || /^(fc|fd|fe[89ab])/i.test(ip))
}
export function gatewayPeer(request: IncomingMessage, config?: GatewayConfig): string | null {
  if (!config || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) return null
  const token = request.headers['x-javdex-gateway']
  const peer = request.headers['x-javdex-peer']
  if (typeof token !== 'string' || token.length !== config.token.length ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(config.token)) || typeof peer !== 'string' || !isIP(peer)) return null
  return peer
}
