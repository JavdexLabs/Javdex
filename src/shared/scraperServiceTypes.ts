export const SCRAPER_SERVICE_IDS = ['metatube'] as const

export type ScraperServiceId = (typeof SCRAPER_SERVICE_IDS)[number]

export type ScraperServiceQueryValue = string | number | boolean | undefined
export type ScraperServiceQuery = Record<string, ScraperServiceQueryValue>

export interface ScraperServiceStoredConfig {
  serverUrl: string
  useScrapeProxy: boolean
}

export interface ScraperServiceConfigs {
  metatube: ScraperServiceStoredConfig
}

export type ScraperServiceTokenUpdate =
  | { mode: 'keep' }
  | { mode: 'set'; value: string }
  | { mode: 'clear' }

export interface ScraperServiceConfigInput {
  serverUrl: string
  useScrapeProxy: boolean
  tokenUpdate: ScraperServiceTokenUpdate
  acknowledgeInsecureHttp?: boolean
}

export interface ScraperServicePublicConfig extends ScraperServiceStoredConfig {
  hasToken: boolean
  secretProtection: 'secure' | 'degraded' | 'unavailable'
}

export interface ScraperServiceConnectionResult {
  app: 'metatube'
  version: string
  dbVersion: string
  movieProviderCount: number
}

export const DEFAULT_SCRAPER_SERVICE_CONFIGS: ScraperServiceConfigs = {
  metatube: {
    serverUrl: '',
    useScrapeProxy: false
  }
}

const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/

/** Normalize a user-entered service base while preserving an optional reverse-proxy path prefix. */
export function normalizeScraperServiceServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请填写服务端地址')
  const raw = value.trim()
  if (!raw) return ''
  if (CONTROL_CHARACTER_RE.test(raw)) throw new Error('服务端地址包含非法控制字符')

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('服务端地址格式无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('服务端地址仅支持 HTTP 或 HTTPS')
  }
  if (parsed.username || parsed.password) throw new Error('服务端地址不能包含用户名或密码')
  if (parsed.search) throw new Error('服务端地址不能包含查询参数')
  if (parsed.hash) throw new Error('服务端地址不能包含片段')

  const pathPrefix = parsed.pathname === '/'
    ? ''
    : parsed.pathname.replace(/\/+$/, '')
  return `${parsed.origin}${pathPrefix}`
}

export function normalizeScraperServiceConfigs(value: unknown): ScraperServiceConfigs {
  const source = value && typeof value === 'object'
    ? (value as Partial<Record<ScraperServiceId, unknown>>)
    : {}
  const rawMetaTube = source.metatube && typeof source.metatube === 'object'
    ? (source.metatube as Partial<ScraperServiceStoredConfig>)
    : {}
  let serverUrl = ''
  try {
    serverUrl = normalizeScraperServiceServerUrl(rawMetaTube.serverUrl)
  } catch {
    serverUrl = ''
  }
  return {
    metatube: {
      serverUrl,
      useScrapeProxy: rawMetaTube.useScrapeProxy === true
    }
  }
}

export function isLoopbackScraperServiceUrl(serverUrl: string): boolean {
  if (!serverUrl) return false
  let hostname: string
  try {
    hostname = new URL(serverUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return false
  }
  return hostname === 'localhost' || hostname === '::1' || hostname === '0:0:0:0:0:0:0:1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}
