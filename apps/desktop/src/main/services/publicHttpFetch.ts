import tls from 'node:tls'
import { Socket } from 'node:net'
import { Readable } from 'node:stream'
import {
  Agent,
  ProxyAgent,
  type buildConnector,
  request as undiciRequest
} from 'undici'
import { SocksClient } from 'socks'
import {
  resolvePublicHttpUrl,
  type PublicLookupAddress,
  type ResolvedPublicHttpUrl
} from './publicHttpUrl'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export type PublicHttpFetch = (url: string, init: RequestInit) => Promise<Response>
type PublicHttpUrlValidator = (url: string) => Promise<ResolvedPublicHttpUrl | URL>

interface PublicHttpOptions {
  fetchImpl?: PublicHttpFetch
  validateUrl?: PublicHttpUrlValidator
  maxRedirects?: number
  proxyUrl?: string
  timeoutMs?: number
}

interface PublicHttpBufferOptions extends PublicHttpOptions {
  maxBytes?: number
}

export interface PublicHttpHeadResult {
  status: number
  ok: boolean
  sizeBytes: number | null
}

interface ManagedResponse {
  response: Response
  close: () => Promise<void>
}

function normalizedTimeoutMs(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.floor(value ?? fallback))
}

function remainingDeadlineMs(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('链接请求超时')
  return Math.max(1, Math.floor(remaining))
}

async function withinDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = remainingDeadlineMs(deadline)
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('链接请求超时')), remaining)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function normalizedTarget(value: ResolvedPublicHttpUrl | URL): ResolvedPublicHttpUrl {
  return value instanceof URL ? { url: value, addresses: [] } : value
}

function orderedAddresses(addresses: PublicLookupAddress[]): PublicLookupAddress[] {
  return [...addresses].sort((left, right) => {
    if (left.family === right.family) return 0
    return left.family === 4 ? -1 : 1
  })
}

function physicalUrl(target: ResolvedPublicHttpUrl, address: PublicLookupAddress): URL {
  const url = new URL(target.url)
  url.hostname = address.family === 6 ? `[${address.address}]` : address.address
  return url
}

function targetPort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

function createSocksDispatcher(
  proxy: URL,
  target: ResolvedPublicHttpUrl,
  address: PublicLookupAddress,
  timeoutMs: number,
  signal: AbortSignal | null | undefined
): Agent {
  const connector: buildConnector.connector = (_options, callback): void => {
    const deadline = Date.now() + timeoutMs
    const proxySocket = new Socket()
    let activeSocket: Socket = proxySocket
    let settled = false

    const removeAbortListener = (): void => signal?.removeEventListener('abort', onAbort)
    const finish = (...args: Parameters<buildConnector.Callback>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (args[0]) removeAbortListener()
      else activeSocket.once('close', removeAbortListener)
      callback(...args)
    }
    const abortConnection = (message: string): void => {
      const error = new Error(message)
      activeSocket.destroy(error)
      finish(error, null)
    }
    const onAbort = (): void => abortConnection('SOCKS 连接已取消')
    const timer = setTimeout(() => abortConnection('SOCKS 连接超时'), timeoutMs)

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    proxySocket.once('error', (error) => finish(error, null))
    proxySocket.once('connect', () => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        abortConnection('SOCKS 连接超时')
        return
      }

      const client = new SocksClient({
      command: 'connect',
      proxy: {
        host: proxy.hostname,
        port: Number(proxy.port || 1080),
        type: proxy.protocol === 'socks4:' ? 4 : 5,
        ...(proxy.username ? { userId: decodeURIComponent(proxy.username) } : {}),
        ...(proxy.password ? { password: decodeURIComponent(proxy.password) } : {})
      },
      destination: {
        host: address.address,
        port: targetPort(target.url)
      },
        timeout: remaining
      })
      client.once('established', ({ socket }) => {
        activeSocket = socket as Socket
        if (target.url.protocol !== 'https:') {
          finish(null, socket)
          return
        }

        const tlsRemaining = deadline - Date.now()
        if (tlsRemaining <= 0) {
          abortConnection('SOCKS TLS 连接超时')
          return
        }
        const secureSocket = tls.connect({
          socket,
          servername: target.url.hostname
        })
        activeSocket = secureSocket
        secureSocket.setTimeout(tlsRemaining, () => {
          secureSocket.destroy(new Error('SOCKS TLS 连接超时'))
        })
        secureSocket.once('secureConnect', () => {
          secureSocket.setTimeout(0)
          finish(null, secureSocket)
        })
        secureSocket.once('error', (error) => finish(error, null))
      })
      client.once('error', (error) => finish(error, null))
      client.connect(proxySocket)
    })
    proxySocket.connect(Number(proxy.port || 1080), proxy.hostname)
  }
  return new Agent({ connect: connector })
}

function createPinnedDispatcher(
  target: ResolvedPublicHttpUrl,
  address: PublicLookupAddress,
  proxyUrl: string,
  timeoutMs: number,
  signal: AbortSignal | null | undefined
): Agent | ProxyAgent {
  if (!proxyUrl) {
    return new Agent({ connect: { servername: target.url.hostname } })
  }
  const proxy = new URL(proxyUrl)
  if (proxy.protocol === 'socks4:' || proxy.protocol === 'socks5:') {
    return createSocksDispatcher(proxy, target, address, timeoutMs, signal)
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error('不支持的代理协议')
  }
  return new ProxyAgent({
    uri: proxyUrl,
    requestTls: { servername: target.url.hostname }
  })
}

async function requestPinnedTarget(
  target: ResolvedPublicHttpUrl,
  init: RequestInit,
  proxyUrl: string,
  timeoutMs: number
): Promise<ManagedResponse> {
  const addresses = orderedAddresses(target.addresses)
  if (addresses.length === 0) throw new Error('链接没有可用的公网地址')
  let lastError: unknown = new Error('链接请求失败')
  for (const address of addresses) {
    const dispatcher = createPinnedDispatcher(
      target,
      address,
      proxyUrl,
      timeoutMs,
      init.signal
    )
    try {
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      headers.host = target.url.host
      const result = await undiciRequest(physicalUrl(target, address), {
        method: init.method,
        headers,
        signal: init.signal,
        dispatcher
      })
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(result.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(name, item)
        } else if (value != null) {
          responseHeaders.append(name, String(value))
        }
      }
      const bodyAllowed =
        init.method !== 'HEAD' && ![204, 205, 304].includes(result.statusCode)
      const body = bodyAllowed
        ? (Readable.toWeb(result.body) as unknown as ReadableStream<Uint8Array>)
        : null
      if (!bodyAllowed) await result.body.dump()
      return {
        response: new Response(body, {
          status: result.statusCode,
          headers: responseHeaders
        }),
        close: () => dispatcher.close()
      }
    } catch (error) {
      lastError = error
      await dispatcher.close().catch(() => undefined)
    }
  }
  throw lastError
}

async function requestTarget(
  target: ResolvedPublicHttpUrl,
  init: RequestInit,
  options: PublicHttpOptions
): Promise<ManagedResponse> {
  if (options.fetchImpl) {
    return {
      response: await options.fetchImpl(target.url.toString(), init),
      close: async () => undefined
    }
  }
  return requestPinnedTarget(
    target,
    init,
    options.proxyUrl ?? '',
    options.timeoutMs ?? (init.method === 'HEAD' ? 8_000 : 20_000)
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The original HTTP/validation error is more useful than a cleanup failure.
  }
}

async function validateTarget(
  rawUrl: string,
  validateUrl: PublicHttpUrlValidator,
  deadline: number
): Promise<ResolvedPublicHttpUrl> {
  return normalizedTarget(
    await withinDeadline(Promise.resolve().then(() => validateUrl(rawUrl)), deadline)
  )
}

export async function fetchPublicHttpBuffer(
  rawUrl: string,
  options: PublicHttpBufferOptions = {}
): Promise<Buffer> {
  const validateUrl = options.validateUrl ?? resolvePublicHttpUrl
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024
  const maxRedirects = options.maxRedirects ?? 5
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs, 20_000)
  const deadline = Date.now() + timeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  let current = await validateTarget(rawUrl, validateUrl, deadline)

  for (let redirectCount = 0; ; redirectCount += 1) {
    const managed = await withinDeadline(
      requestTarget(
        current,
        {
          redirect: 'manual',
          signal,
          headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
        },
        { ...options, timeoutMs: remainingDeadlineMs(deadline) }
      ),
      deadline
    )
    const { response } = managed
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      await cancelResponseBody(response)
      await managed.close()
      if (!location) throw new Error('图片重定向缺少目标地址')
      if (redirectCount >= maxRedirects) throw new Error('图片重定向次数过多')
      current = await validateTarget(
        new URL(location, current.url).toString(),
        validateUrl,
        deadline
      )
      continue
    }

    try {
      if (!response.ok) {
        await cancelResponseBody(response)
        throw new Error(`HTTP ${response.status}`)
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await cancelResponseBody(response)
        throw new Error('图片文件过大')
      }
      if (!response.body) return Buffer.alloc(0)

      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error('图片文件过大')
        }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks, total)
    } finally {
      await managed.close()
    }
  }
}

export async function fetchPublicHttpHead(
  rawUrl: string,
  options: PublicHttpOptions = {}
): Promise<PublicHttpHeadResult> {
  const validateUrl = options.validateUrl ?? resolvePublicHttpUrl
  const maxRedirects = options.maxRedirects ?? 5
  const timeoutMs = normalizedTimeoutMs(options.timeoutMs, 8_000)
  const deadline = Date.now() + timeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  let current = await validateTarget(rawUrl, validateUrl, deadline)

  for (let redirectCount = 0; ; redirectCount += 1) {
    const managed = await withinDeadline(
      requestTarget(
        current,
        { method: 'HEAD', redirect: 'manual', signal },
        { ...options, timeoutMs: remainingDeadlineMs(deadline) }
      ),
      deadline
    )
    const { response } = managed
    try {
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirectCount >= maxRedirects) throw new Error('链接重定向无效')
        current = await validateTarget(
          new URL(location, current.url).toString(),
          validateUrl,
          deadline
        )
        continue
      }
      const rawLength = response.headers.get('content-length')
      const parsedLength = rawLength == null ? null : Number(rawLength)
      return {
        status: response.status,
        ok: response.ok,
        sizeBytes:
          parsedLength != null && Number.isSafeInteger(parsedLength) && parsedLength >= 0
            ? parsedLength
            : null
      }
    } finally {
      await cancelResponseBody(response)
      await managed.close()
    }
  }
}
