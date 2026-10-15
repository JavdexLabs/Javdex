import { Agent } from 'undici'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'

/** Pin is verified before the dispatcher may send any headers or body. */
export function createPinnedFetch(origin: string, pin?: string): { fetch: (url: string | URL, init?: RequestInit) => Promise<Response>; close: () => Promise<void> } {
  const target = new URL(origin)
  if (pin && (target.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(pin))) throw new Error('证书固定信息无效')
  const agent = pin ? new Agent({ connect: (_options, callback) => {
    const host = target.hostname.replace(/^\[|\]$/g, '')
    const socket = tls.connect({ host, port: Number(target.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' })
    let done = false
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) { socket.destroy(); callback(error, null) } else callback(null, socket)
    }
    const timer = setTimeout(() => finish(new Error('服务端 TLS 连接超时')), 10_000)
    socket.once('error', () => finish(new Error('服务端 TLS 连接失败')))
    socket.once('secureConnect', () => {
      const raw = socket.getPeerCertificate().raw
      finish(!raw || createHash('sha256').update(raw).digest('hex') !== pin ? new Error('服务端证书已变化，请重新核对配对信息') : undefined)
    })
  } }) : undefined
  return {
    fetch: (url, init = {}) => {
      if (new URL(url).origin !== target.origin) return Promise.reject(new Error('拒绝向其他地址发送服务端凭据'))
      return fetch(url, { ...init, redirect: 'error', ...(agent ? { dispatcher: agent } : {}) } as RequestInit)
    },
    close: async () => { await agent?.destroy() }
  }
}
