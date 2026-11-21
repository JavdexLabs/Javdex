import { NETWORK_PROXY_ROUTE_LABELS, type NetworkProxyFeature, type NetworkProxyRoute } from '@shared/networkProxy'
import { setTimeout as wait } from 'node:timers/promises'
import { modelManagement } from '../agent-platform/modelManagement'
import { listScraperPlugins } from '../scrapers/scraperManager'
import { getSettings } from '../settings/settingsStore'
import { fetchWithNetworkProxy, networkProxySession, proxyCandidates } from '../utils/networkProxyTransport'
import { RELEASES_API_URL } from './appReleaseService'
import { llmRequestEndpoints } from './llmClient'
import { getLocalModels } from './localModels/desktopLocalModels'

async function probeTarget(feature: NetworkProxyFeature): Promise<string> {
  if (feature === 'updates') return RELEASES_API_URL
  if (feature === 'downloads') return getLocalModels().downloadUrl('kotoba')
  if (feature === 'scrape') {
    const selected = listScraperPlugins().find(plugin => plugin.name === getSettings().defaultScraper)
    if (selected?.homepage) return selected.homepage
    throw new Error('当前默认影片刮削插件没有主页，请在刮削时验证连接')
  }
  const { connections, models, assignments } = modelManagement.read()
  const assignment = assignments.find(entry => entry.workloadId === 'app-default')
  const model = models.find(entry => entry.id === assignment?.resolution.modelRef)
  const connection = connections.find(entry => entry.id === model?.connectionId)
  if (!connection) throw new Error('请先在「AI 服务」中设置默认在线模型')
  const endpoints = llmRequestEndpoints(connection.protocol, connection.baseUrl)
  return endpoints.openAiModelsUrl ?? endpoints.anthropicModelsUrl ?? endpoints.googleModelsUrl ?? connection.baseUrl
}

async function describeProxy(route: NetworkProxyRoute, url: URL, scope: string): Promise<string> {
  const manual = route.mode === 'manual' ? new URL(route.url) : null
  if (manual?.username || manual?.password) return NETWORK_PROXY_ROUTE_LABELS.manual
  const network = await networkProxySession(scope, route)
  const candidates = proxyCandidates(await network.resolveProxy(url.href))
  if (candidates.length > 1) return `系统规则：${candidates.map(candidate => candidate ? '代理' : '直连').join(' → ')}`
  if (candidates.length === 0) return NETWORK_PROXY_ROUTE_LABELS[route.mode]
  if (!candidates[0]) return route.mode === 'system' ? '系统规则：直连' : '直接连接'
  return route.mode === 'system' ? '系统代理' : NETWORK_PROXY_ROUTE_LABELS[route.mode]
}

export async function testProxyConnection(feature: NetworkProxyFeature, route: NetworkProxyRoute): Promise<string> {
  const url = new URL(await probeTarget(feature))
  url.username = ''
  url.password = ''
  const started = Date.now()
  const scope = `probe-${feature}`
  const timeoutMs = 15_000
  const signal = AbortSignal.timeout(timeoutMs)
  let description: string = NETWORK_PROXY_ROUTE_LABELS[route.mode]
  try {
    description = await Promise.race([
      describeProxy(route, url, scope),
      wait(timeoutMs, undefined, { ref: false }).then(() => { throw new Error('timeout') })
    ])
    const response = await fetchWithNetworkProxy(scope, route, url, {
      method: feature === 'downloads' ? 'HEAD' : 'GET',
      credentials: 'omit',
      signal
    })
    await response.body?.cancel().catch(() => {})
    if (response.status === 407 || response.status >= 500) throw new Error(`HTTP ${response.status}`)
    return `${url.host} · ${description} · HTTP ${response.status} · ${Date.now() - started} ms`
  } catch (error) {
    const detail = (error as Error).message.match(/(?:HTTP \d{3}|ERR_[A-Z_]+|timeout)/i)?.[0]
    throw new Error(`${url.host} · ${description} · 连接失败${detail ? `（${detail}）` : ''}`)
  }
}
