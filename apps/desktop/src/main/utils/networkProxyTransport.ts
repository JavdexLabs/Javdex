import { createHash } from 'node:crypto'
import { session, type AuthInfo, type ProxyConfig, type Session } from 'electron'
import type { ProxyAgent, RequestInit as UndiciRequestInit } from 'undici'
import type { NetworkProxyRoute } from '@shared/networkProxy'
import { httpProxyOptions } from '@library/net/httpProxyOptions'

export function electronProxyConfig(proxyUrl?: string): ProxyConfig {
  if (!proxyUrl) return { mode: 'system' }
  if (proxyUrl === 'direct://') return { mode: 'direct' }
  const url = new URL(proxyUrl)
  return { mode: 'fixed_servers', proxyRules: `${url.protocol}//${url.host}` }
}

export function resolveElectronProxy(route: NetworkProxyRoute): ProxyConfig {
  return electronProxyConfig(route.mode === 'manual' ? route.url : route.mode === 'direct' ? 'direct://' : undefined)
}

export function proxyCredentials(proxyUrl: string | undefined, auth: AuthInfo): [string, string] | [] {
  if (!auth.isProxy || !proxyUrl || proxyUrl === 'direct://') return []
  const url = new URL(proxyUrl)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  const authHost = auth.host.replace(/^\[|\]$/g, '').toLowerCase()
  if ((!url.username && !url.password) || hostname !== authHost || port !== auth.port) return []
  try {
    return [decodeURIComponent(url.username), decodeURIComponent(url.password)]
  } catch {
    return []
  }
}

const sessions = new Map<string, Promise<Session>>()
const authenticatedProxies = new Map<string, { url: string; agent: ProxyAgent }>()

export function networkProxySession(scope: string, route: NetworkProxyRoute): Promise<Session> {
  const config = resolveElectronProxy(route)
  const key = `network-proxy-${scope}-${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 24)}`
  const existing = sessions.get(key)
  if (existing) return existing
  const pending = (async () => {
    const isolated = session.fromPartition(key, { cache: false })
    await isolated.setProxy(config)
    return isolated
  })()
  sessions.set(key, pending)
  void pending.catch(() => sessions.delete(key))
  return pending
}

function authenticatedProxy(scope: string, url: URL, Agent: typeof ProxyAgent): ProxyAgent {
  const previous = authenticatedProxies.get(scope)
  if (previous?.url === url.href) return previous.agent
  const agent = new Agent(httpProxyOptions(url))
  authenticatedProxies.set(scope, { url: url.href, agent })
  if (previous) void previous.agent.close().catch(() => {})
  return agent
}

export async function fetchWithNetworkProxy(
  scope: string,
  route: NetworkProxyRoute,
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(input, init)
  const protocol = new URL(request.url).protocol
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error('仅支持 HTTP / HTTPS 请求')
  const manualUrl = route.mode === 'manual' ? new URL(route.url) : null
  if (manualUrl?.username || manualUrl?.password) {
    const { fetch: undiciFetch, ProxyAgent } = await import('undici')
    const options: UndiciRequestInit = {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      redirect: request.redirect,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
      dispatcher: authenticatedProxy(scope, manualUrl, ProxyAgent)
    }
    return await undiciFetch(request.url, options) as unknown as Response
  }
  const previous = authenticatedProxies.get(scope)
  if (previous) {
    authenticatedProxies.delete(scope)
    void previous.agent.close().catch(() => {})
  }
  const network = await networkProxySession(scope, route)
  return network.fetch(request, { bypassCustomProtocolHandlers: true })
}

export function proxyCandidates(rules: string): string[] {
  const schemes: Record<string, string> = { PROXY: 'http', HTTPS: 'https', SOCKS: 'socks4', SOCKS4: 'socks4', SOCKS5: 'socks5' }
  return rules.split(';').flatMap(rule => {
    const [kind, host] = rule.trim().split(/\s+/)
    if (kind === 'DIRECT') return ['']
    const scheme = schemes[kind]
    return scheme && host ? [`${scheme}://${host}`] : []
  })
}
