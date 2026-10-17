import { z } from 'zod'
import { createPinnedFetch, type VerifyServerCertificate } from '@http/pinnedFetch'
import type { HandshakeResult } from '@shared/protocol/handshake'
import { structuredError } from '@shared/protocol/errors'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { createServerConnectionStore } from './serverConnectionStore'
import { assertRemoteBaseUrl } from './remoteConnectionUrl'

const identitySchema = z.object({ serverId: z.uuid(), catalogId: z.uuid() })
const handshakeSchema = z.object({
  protocolVersion: z.literal(1), appVersion: z.string().min(1).max(128), schemaVersion: z.number().int().positive(),
  identity: identitySchema, writerEpoch: z.number().int().nonnegative(),
  ready: z.enum(['notBound', 'ready', 'frozen', 'recovering', 'migrating']),
  capabilities: z.object({ encryptedAssets: z.literal(false), transcoding: z.literal(false), arbitraryUrlProxy: z.literal(false),
    pluginExecution: z.literal(false), publicInternetDefault: z.literal(false), writerBound: z.boolean(), browserEnabled: z.boolean(), managementEnabled: z.literal(true) })
})
const writerSchema = z.object({ writerEpoch: z.number().int().positive(), bound: z.literal(true), claimId: z.uuid(), maintenanceBusy: z.boolean() })

export interface LegacyServerConnectionMigration {
  readonly completed: boolean
  checkIdentity(hello: HandshakeResult): void
  handshake?(signal?: AbortSignal): Promise<HandshakeResult>
  complete(hello: HandshakeResult, secret: string, signal?: AbortSignal): Promise<void>
}

/** Preserve the old public port; HTTP's implicit 80 must not become HTTPS 443. */
export function legacyHttpsOrigin(address: string): string {
  const url = new URL(address)
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw structuredError('INVALID_INPUT', '旧连接地址无效，请填写 HTTPS 根地址')
  if (url.protocol === 'http:') {
    const port = url.port || '80'
    url.protocol = 'https:'
    url.port = port
  }
  assertRemoteBaseUrl(url.origin)
  return url.origin
}

async function postJson(transport: ReturnType<typeof createPinnedFetch>, origin: string, operation: string, body: unknown, signal: AbortSignal, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await transport.fetch(new URL(`/manage/v1/${operation}`, origin), {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal
  })
  const reader = response.body?.getReader()
  if (!reader) throw structuredError('CONNECTION_UNAVAILABLE', '服务端未返回有效响应')
  const abort = (): void => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const rejectedCredential = Boolean(headers.Authorization) && (response.status === 401 || response.status === 403)
    if (!response.ok) throw structuredError(rejectedCredential ? 'AUTH_REQUIRED' : 'CONNECTION_UNAVAILABLE',
      rejectedCredential ? '原授权已失效，请重新获取令牌授权' : '服务端连接检查失败，请核对 HTTPS 地址')
    if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('服务端响应不是 JSON')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.length
      if (size > 32 * 1024) throw new Error('服务端连接检查响应过大')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function createLegacyServerConnection(options: {
  address: string
  appVersion: string
  settings: DesktopSettingsStore
  connectionStore: ReturnType<typeof createServerConnectionStore>
  verifyCertificate: VerifyServerCertificate
}): { origin: string; verifyCertificate: VerifyServerCertificate; migration: LegacyServerConnectionMigration } {
  const origin = legacyHttpsOrigin(options.address)
  const legacyHttp = new URL(options.address).protocol === 'http:'
  let expected: HandshakeResult['identity'] | undefined = options.connectionStore.readLegacyIdentity(options.address)
  let completed = false
  const verifyCertificate = options.verifyCertificate
  const assertCurrent = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted()
    const current = await options.settings.read()
    if (current.mode !== 'remote' || current.remoteBaseUrl !== options.address)
      throw structuredError('CONNECTION_UNAVAILABLE', '连接配置已变化，已停止旧连接迁移')
    signal.throwIfAborted()
  }
  const assertIdentity = (hello: HandshakeResult): void => {
    const saved = options.connectionStore.read()
    const identity = saved?.pairing ?? expected
    if ((saved && saved.remoteBaseUrl !== origin) || (identity && (identity.serverId !== hello.identity.serverId || identity.catalogId !== hello.identity.catalogId)))
      throw structuredError('INSTANCE_MISMATCH', '服务端或资料库身份已变化，已保留原连接和授权，请核对地址')
  }
  const migration: LegacyServerConnectionMigration = {
    get completed() { return completed },
    checkIdentity: assertIdentity,
    ...(legacyHttp ? { handshake: async (external?: AbortSignal) => {
      const signal = external ? AbortSignal.any([external, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
      await assertCurrent(signal)
      let tlsObserved = false
      const secure = createPinnedFetch(origin, undefined, { verifyCertificate: async (pin, trusted) => {
        tlsObserved = true
        await verifyCertificate(pin, trusted)
      } })
      try {
        const hello = handshakeSchema.parse(await postJson(secure, origin, 'handshake.get', { input: {} }, signal))
        assertIdentity(hello)
        if (hello.appVersion === '0.8.0' && hello.schemaVersion === 19) {
          await assertCurrent(signal)
          options.connectionStore.rememberLegacyIdentity(options.address, hello.identity)
        }
        expected = hello.identity
        return hello
      } catch (error) {
        // Once TLS is established, a refused certificate or invalid response is
        // an HTTPS error, never a reason to fall back to an old HTTP deployment.
        let cause: unknown = error
        const seen = new Set<Error>()
        while (cause instanceof Error && !seen.has(cause)) {
          seen.add(cause)
          if (/证书|certificate/i.test(cause.message)) throw error
          cause = cause.cause
        }
        if (tlsObserved || external?.aborted) throw error
      } finally { await secure.close() }
      const plain = createPinnedFetch(new URL(options.address).origin)
      const probeSignal = external ? AbortSignal.any([external, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
      try {
        await assertCurrent(probeSignal)
        // Public discovery only: no bearer, cookies, writes, redirects or claims.
        const hello = handshakeSchema.parse(await postJson(plain, new URL(options.address).origin, 'handshake.get', { input: {} }, probeSignal))
        if (hello.appVersion !== '0.8.0' || hello.schemaVersion !== 19) throw structuredError('CONNECTION_UNAVAILABLE', '仅支持自动迁移正式 0.8.0 的旧 HTTP 连接，请核对 HTTPS 地址')
        assertIdentity(hello)
        await assertCurrent(probeSignal)
        options.connectionStore.rememberLegacyIdentity(options.address, hello.identity)
        expected = hello.identity
        return hello
      } finally { await plain.close() }
    } } : {}),
    async complete(hello, secret, external) {
      if (completed) return
      // Only the multi-client catalog format can supply a unified connection.
      if (!legacyHttp && hello.schemaVersion < 21) return
      const signal = external ? AbortSignal.any([external, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
      await assertCurrent(signal)
      assertIdentity(hello)
      handshakeSchema.parse(hello)
      if (hello.appVersion !== options.appVersion) throw structuredError('VERSION_MISMATCH', '桌面与服务器应用版本不一致')
      let certificateSha256: string | undefined
      const secure = createPinnedFetch(origin, undefined, { verifyCertificate: async (pin, trusted) => {
        await verifyCertificate(pin, trusted)
        certificateSha256 = pin
      } })
      try {
        const status = writerSchema.parse(await postJson(secure, origin, 'writer.status', {
          serverId: hello.identity.serverId, catalogId: hello.identity.catalogId, writerEpoch: hello.writerEpoch, input: {}
        }, signal, { Authorization: `Bearer ${secret}`, 'X-Javdex-App-Version': options.appVersion }))
        if (status.writerEpoch !== hello.writerEpoch || !certificateSha256) throw structuredError('AUTH_REQUIRED', '原授权状态已变化，请重新检测')
        await assertCurrent(signal)
        assertIdentity(hello)
        // Save the encrypted connection first. If the settings write fails, the
        // same credential and identity can finish this operation on the next try.
        options.connectionStore.write({ protocolVersion: 1, url: origin, certificateSha256, token: secret,
          serverId: hello.identity.serverId, catalogId: hello.identity.catalogId })
        await options.settings.write({ mode: 'remote', remoteBaseUrl: origin })
        completed = true
      } finally { await secure.close() }
    }
  }
  return { origin, verifyCertificate, migration }
}
