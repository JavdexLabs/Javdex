export const NETWORK_PROXY_FEATURES = ['scrape', 'llm', 'updates', 'downloads'] as const

export type NetworkProxyFeature = (typeof NETWORK_PROXY_FEATURES)[number]
export type NetworkProxyRoute = { mode: 'system' } | { mode: 'direct' } | { mode: 'manual'; url: string }

export interface NetworkProxySettings {
  default: NetworkProxyRoute
  overrides: Partial<Record<NetworkProxyFeature, NetworkProxyRoute>>
}

interface StoredNetworkProxySettings {
  networkProxy?: NetworkProxySettings
  proxyUrl?: string
  proxyUrlEnabled?: boolean
  llmProxyUrl?: string
  llmProxyUrlEnabled?: boolean
}

const DEFAULT_ROUTE: NetworkProxyRoute = { mode: 'system' }

export function isManualProxyUrl(value: string): boolean {
  try {
    const url = new URL(value)
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname) && url.pathname === '/' && !url.search && !url.hash
      && /^https?:\/\/[^\s,;\\]+\/?$/i.test(value)
  } catch {
    return false
  }
}

export function normalizeNetworkProxy(value: unknown): NetworkProxySettings | undefined {
  if (!value || typeof value !== 'object' || !('default' in value)) return undefined
  const normalizeRoute = (input: unknown): NetworkProxyRoute | undefined => {
    if (!input || typeof input !== 'object' || !('mode' in input)) return undefined
    if (input.mode === 'manual' && 'url' in input && typeof input.url === 'string' && isManualProxyUrl(input.url.trim())) {
      return { mode: 'manual', url: input.url.trim() }
    }
    if (input.mode === 'system' || input.mode === 'direct') return { mode: input.mode }
  }
  const defaultRoute = normalizeRoute(value.default)
  if (!defaultRoute) return undefined
  const overrides: NetworkProxySettings['overrides'] = {}
  if ('overrides' in value && value.overrides && typeof value.overrides === 'object') {
    const routes = value.overrides as Record<string, unknown>
    for (const feature of NETWORK_PROXY_FEATURES) {
      const route = normalizeRoute(routes[feature])
      if (route) overrides[feature] = route
    }
  }
  return { default: defaultRoute, overrides }
}

export function networkProxySettings(settings: StoredNetworkProxySettings): NetworkProxySettings {
  if (settings.networkProxy) return settings.networkProxy
  const overrides: NetworkProxySettings['overrides'] = {}
  const scrapeUrl = settings.proxyUrl?.trim()
  const llmUrl = settings.llmProxyUrl?.trim()
  if (settings.proxyUrlEnabled && scrapeUrl) {
    overrides.scrape = { mode: 'manual', url: scrapeUrl }
    overrides.updates = { ...overrides.scrape }
  }
  if (settings.llmProxyUrlEnabled && llmUrl) overrides.llm = { mode: 'manual', url: llmUrl }
  return { default: DEFAULT_ROUTE, overrides }
}

export function networkProxyRoute(settings: NetworkProxySettings, feature: NetworkProxyFeature): NetworkProxyRoute {
  return settings.overrides[feature] ?? settings.default
}

export const NETWORK_PROXY_ROUTE_LABELS = {
  system: '跟随系统',
  manual: '手动代理',
  direct: '直接连接'
} satisfies Record<NetworkProxyRoute['mode'], string>

export const NETWORK_PROXY_FEATURE_LABELS = {
  scrape: '刮削与配套图片',
  llm: '在线 AI',
  updates: '应用更新检查',
  downloads: '模型与运行库下载'
} satisfies Record<NetworkProxyFeature, string>
