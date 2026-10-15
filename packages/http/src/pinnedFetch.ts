import { Agent } from 'undici'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'

export type VerifyServerCertificate = (fingerprint: string, publiclyTrusted: boolean) => Promise<void>
export interface PinnedFetchOptions {
  allowSelfSignedCertificate?: boolean
  /** Resolves only after the host has persisted trust or obtained consent to a change. */
  verifyCertificate?: VerifyServerCertificate
}
/** Pin is verified before the dispatcher may send any headers or body. */
export function createPinnedFetch(origin: string, pin?: string, options: PinnedFetchOptions = {}): { fetch: (url: string | URL, init?: RequestInit) => Promise<Response>; close: () => Promise<void> } {
  const target = new URL(origin)
  if (pin && (target.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(pin))) throw new Error('证书固定信息无效')
  const allowSelfSigned = options.allowSelfSignedCertificate && target.protocol === 'https:'
  const agent = pin || allowSelfSigned || options.verifyCertificate ? new Agent({ connect: (_options, callback) => {
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
      const certificate = socket.getPeerCertificate()
      if (options.verifyCertificate) {
        clearTimeout(timer)
        if (!certificate.raw) { finish(new Error('服务器未提供有效证书')); return }
        if (!(Date.parse(certificate.valid_from) <= Date.now() && Date.parse(certificate.valid_to) > Date.now())) {
          finish(new Error('服务器证书不在有效期内')); return
        }
        const error = socket.authorizationError as Error | string | null
        const code = typeof error === 'string' ? error : (error as NodeJS.ErrnoException | null)?.code
        if (!socket.authorized && code !== 'DEPTH_ZERO_SELF_SIGNED_CERT' && code !== 'SELF_SIGNED_CERT_IN_CHAIN') {
          finish(Object.assign(new Error('服务器的 HTTPS 证书校验失败'), { code })); return
        }
        void options.verifyCertificate(createHash('sha256').update(certificate.raw).digest('hex'), socket.authorized).then(() => finish(), error => finish(error instanceof Error ? error : new Error('服务器证书未获信任')))
        return
      }
      if (pin) {
        finish(!certificate.raw || createHash('sha256').update(certificate.raw).digest('hex') !== pin
          ? Object.assign(new Error('服务端证书已变化，请重新核对配对信息'), { code: 'JAVDEX_CERTIFICATE_MISMATCH' }) : undefined)
        return
      }
      if (socket.authorized) { finish(); return }
      const authorizationError = socket.authorizationError as Error | string | null
      const code = typeof authorizationError === 'string' ? authorizationError : (authorizationError as NodeJS.ErrnoException | null)?.code
      // Manual connections accept self-signed certificates for this origin only.
      // A saved pairing pin above always takes precedence over this policy.
      if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
        const now = Date.now()
        if (Date.parse(certificate.valid_from) > now) {
          finish(Object.assign(new Error('服务器证书尚未生效'), { code: 'CERT_NOT_YET_VALID' }))
        } else if (!(Date.parse(certificate.valid_to) > now)) {
          finish(Object.assign(new Error('服务器证书已过期'), { code: 'CERT_HAS_EXPIRED' }))
        } else finish()
        return
      }
      finish(Object.assign(new Error('服务器的 HTTPS 证书校验失败'), { code }))
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
