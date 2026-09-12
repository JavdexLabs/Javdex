import { net, session, type Session } from 'electron'
import { createHash } from 'node:crypto'
import type {
  ScraperServiceConfigInput,
  ScraperServiceConnectionResult,
  ScraperServiceId,
  ScraperServicePublicConfig,
  ScraperServiceQuery,
  ScraperServiceStoredConfig,
  ScraperServiceTokenUpdate
} from '@shared/scraperServiceTypes'
import {
  isLoopbackScraperServiceUrl,
  normalizeScraperServiceServerUrl
} from '@shared/scraperServiceTypes'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { getSettings, updateSettings } from '../settings/settingsStore'
import {
  deleteScraperServiceToken,
  getScraperServiceSecretStorageState,
  getScraperServiceToken,
  hasScraperServiceToken,
  saveScraperServiceToken
} from '../settings/scraperServiceSecretStore'

const DEFAULT_REQUEST_TIMEOUT_MS = 75_000
const CONNECTION_TEST_TIMEOUT_MS = 10_000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const METATUBE_PLUGIN_NAME = 'MetaTube'

export type ScraperServiceErrorCode =
  | 'UNCONFIGURED'
  | 'INVALID_URL'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'HTTP'
  | 'INCOMPATIBLE_RESPONSE'
  | 'RESPONSE_TOO_LARGE'
  | 'REDIRECT_BLOCKED'

export class ScraperServiceError extends Error {
  constructor(
    readonly code: ScraperServiceErrorCode,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'ScraperServiceError'
  }
}

export interface ScraperServiceTransportRequest {
  url: string
  headers: Readonly<Record<string, string>>
  proxyUrl?: string
  timeoutMs: number
  maxBytes: number
}

export interface ScraperServiceTransportResponse {
  statusCode: number
  headers: Readonly<Record<string, string | string[] | undefined>>
  body: Buffer
}

export type ScraperServiceTransport = (
  request: ScraperServiceTransportRequest
) => Promise<ScraperServiceTransportResponse>

export interface ConfiguredScraperServiceClient {
  readonly serviceId: ScraperServiceId
  readonly baseUrl: string
  getJson(relativePath: string, options?: { query?: ScraperServiceQuery }): Promise<unknown>
  publicUrl(relativePath: string, query?: ScraperServiceQuery): string
}

interface ScraperServiceSnapshot {
  serviceId: ScraperServiceId
  baseUrl: string
  token: string
  proxyUrl: string
  timeoutMs: number
}

class TransportTimeoutError extends Error {}
class TransportBodyLimitError extends Error {}

let transportOverride: ScraperServiceTransport | null = null
const serviceSessions = new Map<string, Promise<Session>>()

export function setScraperServiceTransportForTests(
  transport: ScraperServiceTransport | null
): void {
  transportOverride = transport
}

function activeTransport(): ScraperServiceTransport {
  return transportOverride ?? electronScraperServiceTransport
}

function serviceSession(proxyUrl: string | undefined): Promise<Session> {
  const proxyKey = proxyUrl?.trim() || 'direct'
  const key = createHash('sha256').update(proxyKey).digest('hex').slice(0, 16)
  let pending = serviceSessions.get(key)
  if (!pending) {
    pending = (async () => {
      const ses = session.fromPartition(`metatube-service-${key}`)
      await ses.setProxy(proxyUrl ? { proxyRules: proxyUrl } : { mode: 'direct' })
      return ses
    })()
    serviceSessions.set(key, pending)
  }
  return pending
}

async function electronScraperServiceTransport(
  input: ScraperServiceTransportRequest
): Promise<ScraperServiceTransportResponse> {
  const ses = await serviceSession(input.proxyUrl)

  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const resolveOnce = (value: ScraperServiceTransportResponse): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    }
    const req = net.request({
      method: 'GET',
      url: input.url,
      session: ses,
      headers: input.headers,
      redirect: 'manual',
      useSessionCookies: false
    })
    req.on('redirect', (statusCode, _method, redirectUrl, headers) => {
      resolveOnce({
        statusCode,
        headers: { ...headers, location: redirectUrl },
        body: Buffer.alloc(0)
      })
      req.abort()
    })
    req.on('response', (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(declaredLength) && declaredLength > input.maxBytes) {
        rejectOnce(new TransportBodyLimitError('response body limit exceeded'))
        req.abort()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer | Uint8Array | string) => {
        if (settled) return
        const bodyChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += bodyChunk.length
        if (size > input.maxBytes) {
          rejectOnce(new TransportBodyLimitError('response body limit exceeded'))
          req.abort()
          return
        }
        chunks.push(bodyChunk)
      })
      response.on('end', () => {
        resolveOnce({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      })
      response.on('error', rejectOnce)
    })
    timer = setTimeout(() => {
      rejectOnce(new TransportTimeoutError('request timed out'))
      req.abort()
    }, input.timeoutMs)
    req.on('error', rejectOnce)
    req.end()
  })
}

function assertSupportedServiceId(serviceId: ScraperServiceId): void {
  if (serviceId !== 'metatube') throw new Error('未知的刮削服务')
}

function normalizedBasePath(baseUrl: string): string {
  const pathname = new URL(baseUrl).pathname
  return pathname === '/' ? '' : pathname.replace(/\/+$/, '')
}

function assertTargetWithinService(baseUrl: string, target: URL): void {
  const base = new URL(baseUrl)
  if (target.origin !== base.origin) {
    throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube 请求被阻止：目标地址跨越了配置来源')
  }
  const prefix = normalizedBasePath(baseUrl)
  if (prefix && target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`)) {
    throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube 请求被阻止：目标路径离开了配置前缀')
  }
}

function buildServiceUrl(
  baseUrl: string,
  relativePath: string,
  query?: ScraperServiceQuery
): URL {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new ScraperServiceError('INVALID_URL', 'MetaTube 请求路径不能为空')
  }
  const path = relativePath.trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
    throw new ScraperServiceError('INVALID_URL', 'MetaTube 请求只能使用相对路径')
  }
  const base = new URL(baseUrl)
  const prefix = normalizedBasePath(baseUrl)
  const target = new URL(`${prefix}/${path.replace(/^\/+/, '')}`, base.origin)
  assertTargetWithinService(baseUrl, target)
  for (const [name, value] of Object.entries(query ?? {})) {
    if (!name || value === undefined) continue
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ScraperServiceError('INVALID_URL', 'MetaTube 请求包含无效查询参数')
    }
    target.searchParams.set(name, String(value))
  }
  if (target.toString().length > 16_384) {
    throw new ScraperServiceError('INVALID_URL', 'MetaTube 请求地址过长')
  }
  return target
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string
): string | undefined {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase())
  const value = key ? headers[key] : undefined
  return Array.isArray(value) ? value[0] : value
}

function parseJsonBody(response: ScraperServiceTransportResponse): unknown {
  try {
    return JSON.parse(response.body.toString('utf8')) as unknown
  } catch {
    throw new ScraperServiceError(
      'INCOMPATIBLE_RESPONSE',
      'MetaTube 返回了无法解析的 JSON 响应',
      response.statusCode
    )
  }
}

function httpError(status: number): ScraperServiceError {
  if (status === 401) return new ScraperServiceError('AUTH', 'MetaTube 鉴权失败，请检查访问令牌', status)
  if (status === 404) return new ScraperServiceError('NOT_FOUND', 'MetaTube 未找到请求的资源', status)
  if (status === 429) return new ScraperServiceError('RATE_LIMITED', 'MetaTube 请求过于频繁', status)
  if (status >= 500) return new ScraperServiceError('SERVER_ERROR', `MetaTube 服务暂时不可用（HTTP ${status}）`, status)
  return new ScraperServiceError('HTTP', `MetaTube 服务返回 HTTP ${status}`, status)
}

function createClient(snapshot: ScraperServiceSnapshot): ConfiguredScraperServiceClient {
  const transport = activeTransport()
  const requestJson = async (relativePath: string, query?: ScraperServiceQuery): Promise<unknown> => {
    const initial = buildServiceUrl(snapshot.baseUrl, relativePath, query)
    let current = initial
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      let response: ScraperServiceTransportResponse
      try {
        response = await transport({
          url: current.toString(),
          headers: {
            Accept: 'application/json',
            ...(snapshot.token ? { Authorization: `Bearer ${snapshot.token}` } : {})
          },
          proxyUrl: snapshot.proxyUrl || undefined,
          timeoutMs: snapshot.timeoutMs,
          maxBytes: MAX_JSON_BYTES
        })
      } catch (error) {
        if (error instanceof ScraperServiceError) throw error
        if (error instanceof TransportTimeoutError) {
          throw new ScraperServiceError('TIMEOUT', '连接 MetaTube 服务超时')
        }
        if (error instanceof TransportBodyLimitError) {
          throw new ScraperServiceError('RESPONSE_TOO_LARGE', 'MetaTube JSON 响应超过 2 MiB 限制')
        }
        throw new ScraperServiceError('UNREACHABLE', '无法连接 MetaTube 服务端')
      }

      if (response.body.length > MAX_JSON_BYTES) {
        throw new ScraperServiceError('RESPONSE_TOO_LARGE', 'MetaTube JSON 响应超过 2 MiB 限制')
      }
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = headerValue(response.headers, 'location')
        if (!location || redirectCount === MAX_REDIRECTS) {
          throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube 重定向无效或次数过多')
        }
        let redirected: URL
        try {
          redirected = new URL(location, current)
        } catch {
          throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube 返回了无效重定向地址')
        }
        assertTargetWithinService(snapshot.baseUrl, redirected)
        if (current.protocol === 'https:' && redirected.protocol !== 'https:') {
          throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube HTTPS 请求不能降级到 HTTP')
        }
        current = redirected
        continue
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw httpError(response.statusCode)
      }
      return parseJsonBody(response)
    }
    throw new ScraperServiceError('REDIRECT_BLOCKED', 'MetaTube 重定向次数过多')
  }

  return {
    serviceId: snapshot.serviceId,
    baseUrl: snapshot.baseUrl,
    getJson: (relativePath, options) => requestJson(relativePath, options?.query),
    publicUrl: (relativePath, query) => buildServiceUrl(snapshot.baseUrl, relativePath, query).toString()
  }
}

function resolveTokenUpdate(update: ScraperServiceTokenUpdate): string {
  if (update.mode === 'clear') return ''
  if (update.mode === 'set') {
    const value = update.value.trim()
    if (!value) throw new Error('访问令牌不能为空')
    return value
  }
  return getScraperServiceToken('metatube')
}

function storedServiceSnapshot(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): ScraperServiceSnapshot {
  const settings = getSettings()
  const config = settings.scraperServiceConfigs.metatube
  if (!config.serverUrl) {
    throw new ScraperServiceError('UNCONFIGURED', '请先配置 MetaTube 服务端地址')
  }
  return {
    serviceId: 'metatube',
    baseUrl: config.serverUrl,
    token: getScraperServiceToken('metatube'),
    proxyUrl: config.useScrapeProxy ? resolveScrapeProxyUrl(settings) : '',
    timeoutMs
  }
}

export function createConfiguredScraperServiceClient(
  serviceId: ScraperServiceId
): ConfiguredScraperServiceClient {
  assertSupportedServiceId(serviceId)
  return createClient(storedServiceSnapshot())
}

export function isScraperServiceConfigured(serviceId: ScraperServiceId): boolean {
  assertSupportedServiceId(serviceId)
  return Boolean(getSettings().scraperServiceConfigs.metatube.serverUrl)
}

export function getScraperServicePublicConfig(
  serviceId: ScraperServiceId
): ScraperServicePublicConfig {
  assertSupportedServiceId(serviceId)
  const stored = getSettings().scraperServiceConfigs.metatube
  const secretState = getScraperServiceSecretStorageState()
  return {
    ...stored,
    hasToken: hasScraperServiceToken(serviceId),
    secretProtection: secretState.protection
  }
}

function assertInsecureHttpAcknowledged(
  serverUrl: string,
  token: string,
  acknowledged: boolean | undefined
): void {
  if (
    new URL(serverUrl).protocol === 'http:' &&
    !isLoopbackScraperServiceUrl(serverUrl) &&
    token &&
    acknowledged !== true
  ) {
    throw new Error('非本机 HTTP 会明文传输访问令牌，请确认风险后再保存')
  }
}

function updateStoredMetaTubeConfig(config: ScraperServiceStoredConfig): void {
  const settings = getSettings()
  updateSettings({
    scraperServiceConfigs: {
      ...settings.scraperServiceConfigs,
      metatube: config
    }
  })
}

export function saveScraperServiceConfig(
  serviceId: ScraperServiceId,
  input: ScraperServiceConfigInput
): ScraperServicePublicConfig {
  assertSupportedServiceId(serviceId)
  let serverUrl: string
  try {
    serverUrl = normalizeScraperServiceServerUrl(input.serverUrl)
  } catch (error) {
    throw new ScraperServiceError('INVALID_URL', (error as Error).message)
  }
  if (!serverUrl) throw new Error('请填写 MetaTube 服务端地址')
  const nextToken = resolveTokenUpdate(input.tokenUpdate)
  assertInsecureHttpAcknowledged(serverUrl, nextToken, input.acknowledgeInsecureHttp)

  const previous = { ...getSettings().scraperServiceConfigs.metatube }
  updateStoredMetaTubeConfig({ serverUrl, useScrapeProxy: input.useScrapeProxy === true })
  try {
    if (input.tokenUpdate.mode === 'set') saveScraperServiceToken(serviceId, nextToken)
    if (input.tokenUpdate.mode === 'clear') deleteScraperServiceToken(serviceId)
  } catch (error) {
    try {
      updateStoredMetaTubeConfig(previous)
    } catch (rollbackError) {
      throw new Error(
        `${(error as Error).message}；恢复原服务配置失败：${(rollbackError as Error).message}`
      )
    }
    throw error
  }
  return getScraperServicePublicConfig(serviceId)
}

function metaTubeConfigurationReferences(): string[] {
  const settings = getSettings()
  const references: string[] = []
  if (settings.defaultScraper === METATUBE_PLUGIN_NAME) references.push('默认影片刮削源')
  for (const composite of settings.compositeScrapers.video) {
    const fields = Object.entries(composite.fieldPluginMap)
      .filter(([, pluginName]) => pluginName === METATUBE_PLUGIN_NAME)
      .map(([field]) => field)
    if (fields.length) references.push(`组合「${composite.name}」字段：${fields.join('、')}`)
  }
  return references
}

export function clearScraperServiceConfig(serviceId: ScraperServiceId): void {
  assertSupportedServiceId(serviceId)
  const references = metaTubeConfigurationReferences()
  if (references.length) {
    throw new Error(`MetaTube 仍被以下配置引用，请先修改：${references.join('；')}`)
  }
  const previous = { ...getSettings().scraperServiceConfigs.metatube }
  updateStoredMetaTubeConfig({ serverUrl: '', useScrapeProxy: false })
  try {
    deleteScraperServiceToken(serviceId)
  } catch (error) {
    try {
      updateStoredMetaTubeConfig(previous)
    } catch (rollbackError) {
      throw new Error(
        `${(error as Error).message}；恢复原服务配置失败：${(rollbackError as Error).message}`
      )
    }
    throw error
  }
}

function envelopeData(payload: unknown, endpoint: string): unknown {
  if (!payload || typeof payload !== 'object' || !Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new ScraperServiceError(
      'INCOMPATIBLE_RESPONSE',
      `MetaTube ${endpoint} 响应缺少 data 字段`
    )
  }
  return (payload as { data: unknown }).data
}

export async function testScraperServiceConnection(
  serviceId: ScraperServiceId,
  input: ScraperServiceConfigInput
): Promise<ScraperServiceConnectionResult> {
  assertSupportedServiceId(serviceId)
  let serverUrl: string
  try {
    serverUrl = normalizeScraperServiceServerUrl(input.serverUrl)
  } catch (error) {
    throw new ScraperServiceError('INVALID_URL', (error as Error).message)
  }
  if (!serverUrl) throw new Error('请填写 MetaTube 服务端地址')
  const settings = getSettings()
  const client = createClient({
    serviceId,
    baseUrl: serverUrl,
    token: resolveTokenUpdate(input.tokenUpdate),
    proxyUrl: input.useScrapeProxy ? resolveScrapeProxyUrl(settings) : '',
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS
  })

  const root = envelopeData(await client.getJson('/'), '根端点')
  if (!root || typeof root !== 'object') {
    throw new ScraperServiceError('INCOMPATIBLE_RESPONSE', '目标地址不是兼容的 MetaTube 服务')
  }
  const app = (root as { app?: unknown }).app
  const version = (root as { version?: unknown }).version
  if (app !== 'metatube' || typeof version !== 'string' || !version.trim()) {
    throw new ScraperServiceError('INCOMPATIBLE_RESPONSE', '目标地址不是兼容的 MetaTube 服务')
  }

  const providers = envelopeData(await client.getJson('/v1/providers'), 'Provider')
  const movieProviders = providers && typeof providers === 'object'
    ? (providers as { movie_providers?: unknown }).movie_providers
    : null
  if (!movieProviders || typeof movieProviders !== 'object' || Array.isArray(movieProviders)) {
    throw new ScraperServiceError('INCOMPATIBLE_RESPONSE', 'MetaTube Provider 响应格式不兼容')
  }
  const movieProviderCount = Object.keys(movieProviders).length
  if (movieProviderCount === 0) throw new Error('MetaTube 服务没有可用的影片 Provider')

  const database = envelopeData(await client.getJson('/v1/db/version'), '数据库版本')
  const rawDbVersion = database && typeof database === 'object'
    ? (database as { version?: unknown }).version
    : undefined
  if (rawDbVersion === undefined || rawDbVersion === null || String(rawDbVersion).trim() === '') {
    throw new ScraperServiceError('INCOMPATIBLE_RESPONSE', 'MetaTube 数据库版本响应格式不兼容')
  }

  return {
    app: 'metatube',
    version: version.trim(),
    dbVersion: String(rawDbVersion),
    movieProviderCount
  }
}
