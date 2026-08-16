import { app } from 'electron'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import type { ActressScrapeResult, ScraperPluginKind } from '@shared/scrapeTypes'
import type { VideoPluginScrapeResult } from '@shared/videoScrapeTypes'
import type { ScraperServiceId, ScraperServiceQuery } from '@shared/scrapeTypes'
import { readTestUserDataPath } from '@shared/appIdentity'
import { scrapeBrowser } from './scrapeBrowser'
import {
  ScraperResourceCache,
  type ScraperResourceResponse
} from './scraperResourceCache'
import {
  createConfiguredScraperServiceClient,
  ScraperServiceError,
  type ConfiguredScraperServiceClient
} from './configuredScraperService'

const PLUGIN_VALIDATE_TIMEOUT_MS = 10_000
const PLUGIN_PARSE_TIMEOUT_MS = 5 * 60_000

interface FetchPageOptions {
  readySelector?: string
  timeoutMs?: number
  settleWhenText?: RegExp
}

interface FetchBufferOptions {
  cache?: {
    mode: 'persistent'
    maxAgeMs: number
    staleIfError: boolean
  }
}

interface SandboxWorkerData {
  mode: 'validate' | 'parse'
  kind: ScraperPluginKind
  pluginName: string
  code: string
  appRoot: string
  proxyUrl?: string
  serviceBinding?: ScraperServiceId
  service?: {
    id: ScraperServiceId
    baseUrl: string
  }
  task?: {
    code?: string
    mainName?: string
    aliases?: string[]
  }
}

/** App root for worker-side createRequire (eval workers cannot resolve asar modules). */
function sandboxAppRoot(): string {
  try {
    const appPath = app?.getAppPath?.()
    if (appPath) return appPath
  } catch {
    /* Electron app may not be ready in tests. */
  }
  return process.cwd()
}

type SandboxWorkerInput = Omit<SandboxWorkerData, 'appRoot' | 'service'>

function withSandboxAppRoot(workerData: SandboxWorkerInput): SandboxWorkerData {
  return { ...workerData, appRoot: sandboxAppRoot() }
}

type SandboxMessage =
  | { type: 'done'; result?: unknown }
  | { type: 'error'; error: string }
  | { type: 'fetchPage'; id: number; url: unknown; options?: unknown }
  | { type: 'fetchBuffer'; id: number; url: unknown; options?: unknown }
  | { type: 'serviceGetJson'; id: number; path: unknown; options?: unknown }
  | { type: 'browserAction'; id: number; action: unknown; params?: unknown }
  | { type: 'log'; level: string; message: string }

interface RpcReply {
  type: 'rpcResult'
  id: number
  ok: boolean
  value?: unknown
  error?: {
    message: string
    code?: string
    status?: number
  }
}

interface SandboxRunResult<T> {
  result: T
  logs: string[]
}

type SandboxBufferFetcher = (
  url: string,
  proxyUrl: string | undefined,
  headers: Readonly<Record<string, string>>
) => Promise<ScraperResourceResponse>

type SandboxPageFetcher = (
  url: string,
  proxyUrl: string | undefined,
  options: FetchPageOptions | undefined
) => Promise<string>

let resourceCache: ScraperResourceCache | null = null
let sandboxBufferFetcher: SandboxBufferFetcher = defaultSandboxBufferFetcher
let sandboxPageFetcher: SandboxPageFetcher = defaultSandboxPageFetcher

export function setSandboxBufferFetcherForTests(fetcher?: SandboxBufferFetcher): void {
  sandboxBufferFetcher = fetcher ?? defaultSandboxBufferFetcher
  resourceCache = null
}

export function setSandboxPageFetcherForTests(fetcher?: SandboxPageFetcher): void {
  sandboxPageFetcher = fetcher ?? defaultSandboxPageFetcher
}

export async function validateUserPluginCode(
  kind: ScraperPluginKind,
  pluginName: string,
  code: string
): Promise<void> {
  await runSandboxWorker({
    mode: 'validate',
    kind,
    pluginName,
    code
  }, PLUGIN_VALIDATE_TIMEOUT_MS)
}

export function runUserVideoPlugin(
  pluginName: string,
  code: string,
  videoCode: string,
  proxyUrl?: string,
  serviceBinding?: ScraperServiceId
): Promise<VideoPluginScrapeResult> {
  return runSandboxWorker<VideoPluginScrapeResult>({
    mode: 'parse',
    kind: 'video',
    pluginName,
    code,
    proxyUrl,
    serviceBinding,
    task: { code: videoCode }
  }, PLUGIN_PARSE_TIMEOUT_MS)
}

export function runUserVideoPluginWithLogs(
  pluginName: string,
  code: string,
  videoCode: string,
  proxyUrl?: string
): Promise<SandboxRunResult<VideoPluginScrapeResult>> {
  return runSandboxWorkerCollect<VideoPluginScrapeResult>({
    mode: 'parse',
    kind: 'video',
    pluginName,
    code,
    proxyUrl,
    task: { code: videoCode }
  }, PLUGIN_PARSE_TIMEOUT_MS)
}

export function runUserActressPlugin(
  pluginName: string,
  code: string,
  mainName: string,
  aliases: string[],
  proxyUrl?: string
): Promise<ActressScrapeResult | null> {
  return runSandboxWorker<ActressScrapeResult | null>({
    mode: 'parse',
    kind: 'actress',
    pluginName,
    code,
    proxyUrl,
    task: { mainName, aliases }
  }, PLUGIN_PARSE_TIMEOUT_MS)
}

export function runUserActressPluginWithLogs(
  pluginName: string,
  code: string,
  mainName: string,
  aliases: string[],
  proxyUrl?: string
): Promise<SandboxRunResult<ActressScrapeResult | null>> {
  return runSandboxWorkerCollect<ActressScrapeResult | null>({
    mode: 'parse',
    kind: 'actress',
    pluginName,
    code,
    proxyUrl,
    task: { mainName, aliases }
  }, PLUGIN_PARSE_TIMEOUT_MS)
}

function runSandboxWorker<T = void>(
  workerData: SandboxWorkerInput,
  timeoutMs: number
): Promise<T> {
  return runSandboxWorkerInternal<T>(workerData, timeoutMs, false) as Promise<T>
}

function runSandboxWorkerCollect<T = void>(
  workerData: SandboxWorkerInput,
  timeoutMs: number
): Promise<SandboxRunResult<T>> {
  return runSandboxWorkerInternal<T>(workerData, timeoutMs, true) as Promise<SandboxRunResult<T>>
}

function runSandboxWorkerInternal<T = void>(
  workerData: SandboxWorkerInput,
  timeoutMs: number,
  collectLogs: boolean
): Promise<T | SandboxRunResult<T>> {
  const initialPayload = withSandboxAppRoot(workerData)
  const serviceClient = initialPayload.serviceBinding
    ? createConfiguredScraperServiceClient(initialPayload.serviceBinding)
    : null
  const payload: SandboxWorkerData = serviceClient
    ? {
        ...initialPayload,
        service: { id: serviceClient.serviceId, baseUrl: serviceClient.baseUrl }
      }
    : initialPayload

  return new Promise<T | SandboxRunResult<T>>((resolve, reject) => {
    const worker = new Worker(SANDBOX_WORKER_SOURCE, {
      eval: true,
      workerData: payload
    })

    let settled = false
    const logs: string[] = []
    const timer = setTimeout(() => {
      settle(
        () => reject(new Error(`Scraper plugin ${payload.pluginName} timed out`)),
        true
      )
    }, timeoutMs)

    const settle = (finish: () => void, terminate: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.removeAllListeners()
      if (terminate) {
        void worker.terminate()
      }
      finish()
    }

    worker.on('message', (message: SandboxMessage) => {
      if (!message || typeof message !== 'object') return
      if (message.type === 'done') {
        settle(
          () =>
            resolve(
              collectLogs
                ? ({ result: message.result as T, logs } satisfies SandboxRunResult<T>)
                : (message.result as T)
            ),
          true
        )
      } else if (message.type === 'error') {
        const err = new Error(message.error) as Error & { logs?: string[] }
        if (collectLogs) err.logs = logs
        settle(() => reject(err), true)
      } else if (
        message.type === 'fetchPage' ||
        message.type === 'fetchBuffer' ||
        message.type === 'serviceGetJson' ||
        message.type === 'browserAction'
      ) {
        void handleWorkerRpc(worker, payload, serviceClient, message)
      } else if (message.type === 'log') {
        if (collectLogs) logs.push(`[${message.level}] ${message.message}`)
        console.log(`[scraper:${payload.pluginName}] ${message.message}`)
      }
    })

    worker.on('error', (err) => {
      if (collectLogs) (err as Error & { logs?: string[] }).logs = logs
      settle(() => reject(err), true)
    })

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        settle(
          () => {
            const err = new Error(
              `Scraper plugin ${payload.pluginName} exited with ${code}`
            ) as Error & { logs?: string[] }
            if (collectLogs) err.logs = logs
            reject(err)
          },
          false
        )
      }
    })
  })
}

async function handleWorkerRpc(
  worker: Worker,
  workerData: SandboxWorkerData,
  serviceClient: ConfiguredScraperServiceClient | null,
  message: Extract<
    SandboxMessage,
    { type: 'fetchPage' | 'fetchBuffer' | 'serviceGetJson' | 'browserAction' }
  >
): Promise<void> {
  const reply = (payload: Omit<RpcReply, 'type' | 'id'>): void => {
    worker.postMessage({ type: 'rpcResult', id: message.id, ...payload } satisfies RpcReply)
  }

  try {
    if (message.type === 'fetchPage') {
      const url = parseHttpUrl(message.url)
      const options = parseFetchPageOptions(message.options)
      const html = await sandboxPageFetcher(url, workerData.proxyUrl, options)
      reply({ ok: true, value: html })
    } else if (message.type === 'fetchBuffer') {
      const url = parseHttpUrl(message.url)
      const options = parseFetchBufferOptions(message.options)
      const buf = options?.cache
        ? await getResourceCache().fetch(
            {
              kind: workerData.kind,
              pluginName: workerData.pluginName,
              url,
              maxAgeMs: options.cache.maxAgeMs,
              staleIfError: options.cache.staleIfError
            },
            (resourceUrl, headers) =>
              sandboxBufferFetcher(resourceUrl, workerData.proxyUrl, headers)
          )
        : await fetchUncachedSandboxBuffer(url, workerData.proxyUrl)
      reply({ ok: true, value: buf.toString('base64') })
    } else if (message.type === 'serviceGetJson') {
      if (!serviceClient || !workerData.serviceBinding) {
        throw new Error('Trusted scraper service is unavailable')
      }
      const path = parseServiceRelativePath(message.path)
      const options = parseServiceRequestOptions(message.options)
      const value = await serviceClient.getJson(path, options)
      reply({ ok: true, value })
    } else {
      await scrapeBrowser.setProxy(workerData.proxyUrl)
      const value = await scrapeBrowser.performAction(
        parseBrowserAction(message.action),
        parseBrowserActionParams(message.params)
      )
      reply({ ok: true, value })
    }
  } catch (err) {
    const error = err as Error & { code?: string; status?: number }
    reply({
      ok: false,
      error: {
        message: error.message,
        code: err instanceof ScraperServiceError ? err.code : error.code,
        status: err instanceof ScraperServiceError ? err.status : error.status
      }
    })
  }
}

function parseServiceRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Service path must be a non-empty string')
  }
  return value.trim()
}

function parseServiceRequestOptions(
  value: unknown
): { query?: ScraperServiceQuery } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const rawQuery = (value as { query?: unknown }).query
  if (rawQuery === undefined) return undefined
  if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    throw new Error('Service query must be an object')
  }
  const query: ScraperServiceQuery = {}
  for (const [name, item] of Object.entries(rawQuery)) {
    if (
      item !== undefined &&
      typeof item !== 'string' &&
      typeof item !== 'number' &&
      typeof item !== 'boolean'
    ) {
      throw new Error('Service query values must be strings, numbers, or booleans')
    }
    query[name] = item
  }
  return { query }
}

async function fetchUncachedSandboxBuffer(
  url: string,
  proxyUrl: string | undefined
): Promise<Buffer> {
  await scrapeBrowser.setProxy(proxyUrl)
  return scrapeBrowser.fetchBuffer(url)
}

async function defaultSandboxBufferFetcher(
  url: string,
  proxyUrl: string | undefined,
  headers: Readonly<Record<string, string>>
): Promise<ScraperResourceResponse> {
  await scrapeBrowser.setProxy(proxyUrl)
  return scrapeBrowser.fetchBufferResponse(url, {
    headers,
    referer: 'omit'
  })
}

async function defaultSandboxPageFetcher(
  url: string,
  proxyUrl: string | undefined,
  options: FetchPageOptions | undefined
): Promise<string> {
  await scrapeBrowser.setProxy(proxyUrl)
  return scrapeBrowser.fetchPage(url, options)
}

function getResourceCache(): ScraperResourceCache {
  if (resourceCache) return resourceCache
  const userData =
    readTestUserDataPath() ??
    (typeof app?.getPath === 'function' ? app.getPath('userData') : undefined)
  if (!userData) throw new Error('Electron app userData path is unavailable')
  resourceCache = new ScraperResourceCache({
    rootDir: path.join(userData, 'scraper_resource_cache')
  })
  return resourceCache
}

function parseBrowserAction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Browser action must be a non-empty string')
  }
  return value.trim()
}

function parseBrowserActionParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {}
  return value as Record<string, unknown>
}

function parseHttpUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Plugin fetch URL must be a non-empty string')
  }
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Plugin fetch URL must use http or https')
  }
  return url.toString()
}

function parseFetchPageOptions(value: unknown): FetchPageOptions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const out: FetchPageOptions = {}

  if (typeof input.readySelector === 'string' && input.readySelector.trim()) {
    out.readySelector = input.readySelector
  }
  if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs)) {
    out.timeoutMs = Math.max(1_000, Math.min(300_000, Math.round(input.timeoutMs)))
  }
  if (input.settleWhenText instanceof RegExp) {
    out.settleWhenText = input.settleWhenText
  }

  return out
}

function parseFetchBufferOptions(value: unknown): FetchBufferOptions | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  if (!input.cache || typeof input.cache !== 'object') return undefined
  const cache = input.cache as Record<string, unknown>
  if (cache.mode !== 'persistent') {
    throw new Error('Plugin fetchBuffer cache mode must be persistent')
  }
  if (typeof cache.maxAgeMs !== 'number' || !Number.isFinite(cache.maxAgeMs)) {
    throw new Error('Plugin fetchBuffer cache maxAgeMs must be a finite number')
  }
  return {
    cache: {
      mode: 'persistent',
      maxAgeMs: Math.max(0, Math.min(30 * 24 * 60 * 60 * 1000, Math.round(cache.maxAgeMs))),
      staleIfError: cache.staleIfError === true
    }
  }
}

const SANDBOX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const requireFromApp = createRequire(join(workerData.appRoot, 'package.json'));
const cheerio = requireFromApp('cheerio');

let nextRpcId = 1;
const pending = new Map();

parentPort.on('message', (message) => {
  if (!message || message.type !== 'rpcResult') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else {
    const detail = message.error && typeof message.error === 'object'
      ? message.error
      : { message: String(message.error || 'Plugin fetch failed') };
    const error = new Error(detail.message || 'Plugin fetch failed');
    if (detail.code) error.code = detail.code;
    if (Number.isFinite(detail.status)) error.status = detail.status;
    entry.reject(error);
  }
});

function postError(err) {
  parentPort.postMessage({
    type: 'error',
    error: err && err.message ? String(err.message) : String(err)
  });
}

function rpc(type, payload) {
  const id = nextRpcId++;
  parentPort.postMessage(Object.assign({ type, id }, payload));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function fetchPage(url, options) {
  return rpc('fetchPage', { url, options });
}

function serviceGetJson(path, options) {
  return rpc('serviceGetJson', { path, options });
}

function servicePublicUrl(relativePath, query) {
  if (!workerData.service) throw new Error('Trusted scraper service is unavailable');
  const path = String(relativePath || '').trim();
  if (!path || /^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || path.includes('\\')) {
    throw new Error('Service URL must use a relative path');
  }
  const base = new URL(workerData.service.baseUrl);
  const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/+$/, '');
  const target = new URL(prefix + '/' + path.replace(/^\/+/, ''), base.origin);
  if (target.origin !== base.origin || (prefix && target.pathname !== prefix && !target.pathname.startsWith(prefix + '/'))) {
    throw new Error('Service URL escaped the configured base path');
  }
  for (const [name, value] of Object.entries(query || {})) {
    if (value === undefined) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error('Service query values must be strings, numbers, or booleans');
    }
    target.searchParams.set(name, String(value));
  }
  if (target.toString().length > 16384) throw new Error('Service URL is too long');
  return target.toString();
}

async function fetchBuffer(url, options) {
  const base64 = await rpc('fetchBuffer', { url, options });
  return Buffer.from(String(base64 || ''), 'base64');
}

function browserAction(action, params) {
  return rpc('browserAction', { action, params });
}

const browser = {
  snapshot: (options) => browserAction('snapshot', options || {}),
  click: (selector) => browserAction('click', { selector }),
  type: (selector, text, options) => browserAction('type', Object.assign({ selector, text }, options || {})),
  press: (key) => browserAction('press', { key }),
  waitForSelector: (selector, options) => browserAction('waitForSelector', Object.assign({ selector }, options || {})),
  wait: (timeoutMs) => browserAction('wait', { timeoutMs }),
  inspect: (options) => browserAction('inspect', options || {}),
  html: () => browserAction('html', {}),
  url: () => browserAction('url', {})
};

function absoluteUrl(href, baseUrl) {
  if (!href) return undefined;
  if (String(href).startsWith('//')) return 'https:' + href;
  try {
    return new URL(String(href), String(baseUrl)).toString();
  } catch (_err) {
    return String(href);
  }
}

function normalizeDate(input) {
  const text = String(input || '').trim();
  const monthOnly = text.match(/^(\d{4})\D{1,3}(\d{1,2})(?:\s*月)?$/);
  if (monthOnly) return formatDate(monthOnly[1], monthOnly[2], '1');
  const full = text.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})(?!\d)/);
  if (full) return formatDate(full[1], full[2], full[3]);
  return undefined;
}

function formatDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31 ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return undefined;
  }
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function normalizeText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = value == null ? '' : String(value).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

async function main() {
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    console: {
      log: (...args) => parentPort.postMessage({ type: 'log', level: 'log', message: args.map(String).join(' ') }),
      warn: (...args) => parentPort.postMessage({ type: 'log', level: 'warn', message: args.map(String).join(' ') }),
      error: (...args) => parentPort.postMessage({ type: 'log', level: 'error', message: args.map(String).join(' ') })
    },
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    setTimeout,
    clearTimeout
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox, {
    name: 'scraper-plugin:' + workerData.pluginName
  });
  const script = new vm.Script(workerData.code, {
    filename: workerData.pluginName + '.cjs'
  });
  script.runInContext(context, { timeout: 1000 });

  const loaded = module.exports && typeof module.exports === 'object' && 'default' in module.exports
    ? (module.exports.default || module.exports)
    : module.exports;
  const parser = workerData.kind === 'video'
    ? (loaded.parseVideo || loaded.parseTask)
    : (loaded.parseActress || loaded.parseTask);

  if (typeof parser !== 'function') {
    throw new Error(workerData.kind === 'video' ? 'Missing parseVideo(ctx)' : 'Missing parseActress(ctx)');
  }

  if (workerData.mode === 'validate') {
    parentPort.postMessage({ type: 'done' });
    return;
  }

  const helpers = { absoluteUrl, normalizeDate, normalizeText, unique };
  const service = workerData.service ? {
    getJson: serviceGetJson,
    publicUrl: servicePublicUrl
  } : undefined;
  let result;
  if (workerData.kind === 'video') {
    const ctx = {
      code: workerData.task && workerData.task.code,
      proxyUrl: workerData.proxyUrl,
      cheerio,
      fetchPage,
      fetchBuffer,
      browser,
      helpers,
      ...(service ? { service } : {})
    };
    result = loaded.parseVideo ? await loaded.parseVideo(ctx) : await loaded.parseTask(ctx, workerData.proxyUrl);
  } else {
    const ctx = {
      mainName: workerData.task && workerData.task.mainName,
      aliases: (workerData.task && workerData.task.aliases) || [],
      proxyUrl: workerData.proxyUrl,
      cheerio,
      fetchPage,
      fetchBuffer,
      browser,
      helpers
    };
    result = loaded.parseActress
      ? await loaded.parseActress(ctx)
      : await loaded.parseTask(ctx, ctx.aliases, workerData.proxyUrl);
  }

  parentPort.postMessage({ type: 'done', result });
}

main().catch(postError);
`
