import { SERVER_ENVIRONMENT_VERSION, evaluateServerEnvironment, serverEnvironmentInfoSchema, type ServerEnvironmentSnapshot } from '@shared/serverEnvironment'
import { createPinnedFetch, type VerifyServerCertificate } from './pinnedFetch'

const MAX_RESPONSE_BYTES = 16 * 1024

class EnvironmentResponseError extends Error {}

function unavailable(message: string, requiredVersion: number): ServerEnvironmentSnapshot {
  return { state: 'unavailable', currentVersion: null, requiredVersion, runtimeId: null, platform: null, message: `无法确认服务端运行环境：${message}` }
}

async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new EnvironmentResponseError('查询响应过大（上限 16 KiB）')
  if (!response.body) throw new EnvironmentResponseError('查询接口未返回有效 JSON 响应')
  const reader = response.body.getReader()
  // Fetch's internal abort follower can be collected after headers arrive.
  // Own body cancellation as well, so the deadline still stops a pending read.
  const abort = (): void => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new EnvironmentResponseError('查询响应过大（上限 16 KiB）')
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  } finally {
    signal.removeEventListener('abort', abort)
    try { await reader.cancel().catch(() => undefined) }
    finally { reader.releaseLock() }
  }
}

/** This image-owned endpoint does not require pairing or a matching business version. */
export async function queryServerEnvironment(baseUrl: string, verifyCertificate?: VerifyServerCertificate, requiredVersion = SERVER_ENVIRONMENT_VERSION): Promise<ServerEnvironmentSnapshot> {
  let url: URL
  try { url = new URL('/runtime/v1/info', baseUrl) }
  catch { return unavailable('服务端地址无效，请核对连接地址', requiredVersion) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return unavailable('请使用不含凭据的 HTTP/HTTPS 服务端地址', requiredVersion)
  }
  const controller = new AbortController()
  const { signal } = controller
  const timer = setTimeout(() => controller.abort(), 5_000)
  const transport = createPinnedFetch(url.origin, undefined, {
    verifyCertificate: verifyCertificate ? async (fingerprint, publiclyTrusted) => {
      signal.throwIfAborted()
      let abort!: () => void
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
      // An unanswered trust prompt must not keep the dispatcher's TLS socket alive.
      try { await Promise.race([verifyCertificate(fingerprint, publiclyTrusted), cancelled]) }
      finally { signal.removeEventListener('abort', abort) }
    } : undefined
  })
  let response: Response | undefined
  try {
    response = await transport.fetch(url, {
      method: 'GET', credentials: 'omit',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
      signal
    })
    if (response.status === 404 || response.status === 405) return evaluateServerEnvironment(null, requiredVersion)
    if (response.status !== 200) {
      return unavailable(response.status === 401 || response.status === 403
        ? `查询接口要求授权（HTTP ${response.status}），请核对服务端或反向代理配置`
        : `查询接口返回 HTTP ${response.status}，请稍后重试或核对服务端`, requiredVersion)
    }
    if (response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return unavailable('查询接口未返回 JSON，请核对地址和反向代理配置', requiredVersion)
    }
    const body = await readResponse(response, signal)
    let json: unknown
    try { json = JSON.parse(body) }
    catch { return unavailable('查询接口未返回有效 JSON 响应', requiredVersion) }
    const parsed = serverEnvironmentInfoSchema.safeParse(json)
    if (!parsed.success) return unavailable('响应格式或数据无效，请核对镜像和客户端版本', requiredVersion)
    return evaluateServerEnvironment(parsed.data, requiredVersion)
  } catch (error) {
    return unavailable(error instanceof EnvironmentResponseError ? error.message
      : signal.aborted ? '查询超时，请检查连接后重试'
        : '连接或 HTTPS 证书校验失败，请检查连接后重试', requiredVersion)
  } finally {
    clearTimeout(timer)
    controller.abort()
    try { await response?.body?.cancel().catch(() => undefined) }
    finally { await transport.close() }
  }
}
