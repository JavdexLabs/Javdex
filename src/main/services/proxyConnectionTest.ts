import { net, session, type Session } from 'electron'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

const PROBE_URL = 'https://www.gstatic.com/generate_204'
const PROBE_TIMEOUT_MS = 15_000

const SUPPORTED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks4:', 'socks5:'])

/** Validate and normalize a proxy URL before persistence or probing. */
export function normalizeProxyUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('请填写代理地址')
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('代理地址格式不正确，请使用 http://、https:// 或 socks5://')
  }
  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('代理地址仅支持 http、https、socks4、socks5')
  }
  return trimmed
}

function wrapProbeError(err: unknown, fallback: string): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new Error('连接超时，请检查代理地址与端口')
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error('连接被中断，请稍后重试')
  }
  if (err instanceof Error && err.message.trim()) {
    return new Error(`${fallback}：${err.message}`)
  }
  return new Error(fallback)
}

function probeElectronSession(ses: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url: PROBE_URL, session: ses })
    const timer = setTimeout(() => {
      request.abort()
      reject(new Error('连接超时，请检查代理地址与端口'))
    }, PROBE_TIMEOUT_MS)

    request.on('response', (response) => {
      clearTimeout(timer)
      if (response.statusCode && response.statusCode >= 200 && response.statusCode < 400) {
        response.on('data', () => {})
        response.on('end', () => resolve())
        response.on('error', reject)
        return
      }
      reject(new Error(`代理请求失败：HTTP ${response.statusCode ?? 'unknown'}`))
    })
    request.on('error', (err) => {
      clearTimeout(timer)
      reject(wrapProbeError(err, '无法通过代理连接'))
    })
    request.end()
  })
}

/** Probe scrape proxy via Electron session + net.request (same stack as scrapeBrowser). */
export async function testScrapeProxyConnection(proxyUrl: string): Promise<string> {
  const url = normalizeProxyUrl(proxyUrl)
  const ses = session.fromPartition(`proxy-test-scrape:${Date.now()}`)
  const started = Date.now()
  try {
    await ses.setProxy({ proxyRules: url })
    await probeElectronSession(ses)
  } catch (err) {
    throw err instanceof Error ? err : wrapProbeError(err, '无法通过代理连接')
  } finally {
    await ses.clearStorageData().catch(() => {})
    await ses.closeAllConnections?.().catch(() => {})
  }
  return formatProbeSuccess(Date.now() - started)
}

/** Probe LLM proxy via undici ProxyAgent (same stack as llmFetch). */
export async function testLlmProxyConnection(proxyUrl: string): Promise<string> {
  const url = normalizeProxyUrl(proxyUrl)
  const started = Date.now()
  try {
    const dispatcher = new ProxyAgent(url)
    const response = await undiciFetch(PROBE_URL, {
      dispatcher,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    if (response.status < 200 || response.status >= 400) {
      throw new Error(`代理请求失败：HTTP ${response.status}`)
    }
  } catch (err) {
    throw wrapProbeError(err, '无法通过代理连接')
  }
  return formatProbeSuccess(Date.now() - started)
}

export async function testProxyConnection(
  kind: 'scrape' | 'llm',
  proxyUrl: string
): Promise<string> {
  return kind === 'llm'
    ? testLlmProxyConnection(proxyUrl)
    : testScrapeProxyConnection(proxyUrl)
}

function formatProbeSuccess(latencyMs: number): string {
  return `连接成功（${latencyMs} ms）`
}
