import { Worker } from 'node:worker_threads'
import type {
  ActressScrapeResult,
  ScrapeResult,
  ScraperPluginKind
} from '@shared/types'
import { scrapeBrowser } from './scrapeBrowser'

const PLUGIN_VALIDATE_TIMEOUT_MS = 10_000
const PLUGIN_PARSE_TIMEOUT_MS = 5 * 60_000

interface FetchPageOptions {
  readySelector?: string
  timeoutMs?: number
  settleWhenText?: RegExp
}

interface SandboxWorkerData {
  mode: 'validate' | 'parse'
  kind: ScraperPluginKind
  pluginName: string
  code: string
  proxyUrl?: string
  task?: {
    code?: string
    mainName?: string
    aliases?: string[]
  }
}

type SandboxMessage =
  | { type: 'done'; result?: unknown }
  | { type: 'error'; error: string }
  | { type: 'fetchPage'; id: number; url: unknown; options?: unknown }
  | { type: 'fetchBuffer'; id: number; url: unknown }
  | { type: 'browserAction'; id: number; action: unknown; params?: unknown }
  | { type: 'log'; level: string; message: string }

interface RpcReply {
  type: 'rpcResult'
  id: number
  ok: boolean
  value?: unknown
  error?: string
}

interface SandboxRunResult<T> {
  result: T
  logs: string[]
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
  proxyUrl?: string
): Promise<ScrapeResult | null> {
  return runSandboxWorker<ScrapeResult | null>({
    mode: 'parse',
    kind: 'video',
    pluginName,
    code,
    proxyUrl,
    task: { code: videoCode }
  }, PLUGIN_PARSE_TIMEOUT_MS)
}

export function runUserVideoPluginWithLogs(
  pluginName: string,
  code: string,
  videoCode: string,
  proxyUrl?: string
): Promise<SandboxRunResult<ScrapeResult | null>> {
  return runSandboxWorkerCollect<ScrapeResult | null>({
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
  workerData: SandboxWorkerData,
  timeoutMs: number
): Promise<T> {
  return runSandboxWorkerInternal<T>(workerData, timeoutMs, false) as Promise<T>
}

function runSandboxWorkerCollect<T = void>(
  workerData: SandboxWorkerData,
  timeoutMs: number
): Promise<SandboxRunResult<T>> {
  return runSandboxWorkerInternal<T>(workerData, timeoutMs, true) as Promise<SandboxRunResult<T>>
}

function runSandboxWorkerInternal<T = void>(
  workerData: SandboxWorkerData,
  timeoutMs: number,
  collectLogs: boolean
): Promise<T | SandboxRunResult<T>> {
  return new Promise<T | SandboxRunResult<T>>((resolve, reject) => {
    const worker = new Worker(SANDBOX_WORKER_SOURCE, {
      eval: true,
      workerData
    })

    let settled = false
    const logs: string[] = []
    const timer = setTimeout(() => {
      settle(
        () => reject(new Error(`Scraper plugin ${workerData.pluginName} timed out`)),
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
        message.type === 'browserAction'
      ) {
        void handleWorkerRpc(worker, workerData, message)
      } else if (message.type === 'log') {
        if (collectLogs) logs.push(`[${message.level}] ${message.message}`)
        console.log(`[scraper:${workerData.pluginName}] ${message.message}`)
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
              `Scraper plugin ${workerData.pluginName} exited with ${code}`
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
  message: Extract<SandboxMessage, { type: 'fetchPage' | 'fetchBuffer' | 'browserAction' }>
): Promise<void> {
  const reply = (payload: Omit<RpcReply, 'type' | 'id'>): void => {
    worker.postMessage({ type: 'rpcResult', id: message.id, ...payload } satisfies RpcReply)
  }

  try {
    await scrapeBrowser.setProxy(workerData.proxyUrl)

    if (message.type === 'fetchPage') {
      const url = parseHttpUrl(message.url)
      const options = parseFetchPageOptions(message.options)
      const html = await scrapeBrowser.fetchPage(url, options)
      reply({ ok: true, value: html })
    } else if (message.type === 'fetchBuffer') {
      const url = parseHttpUrl(message.url)
      const buf = await scrapeBrowser.fetchBuffer(url)
      reply({ ok: true, value: buf.toString('base64') })
    } else {
      const value = await scrapeBrowser.performAction(
        parseBrowserAction(message.action),
        parseBrowserActionParams(message.params)
      )
      reply({ ok: true, value })
    }
  } catch (err) {
    reply({ ok: false, error: (err as Error).message })
  }
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

const SANDBOX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const cheerio = require('cheerio');

let nextRpcId = 1;
const pending = new Map();

parentPort.on('message', (message) => {
  if (!message || message.type !== 'rpcResult') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new Error(message.error || 'Plugin fetch failed'));
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

async function fetchBuffer(url) {
  const base64 = await rpc('fetchBuffer', { url });
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
  const full = text.match(/(\d{4})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/);
  if (full) return formatDate(full[1], full[2], full[3]);
  const monthOnly = text.match(/(\d{4})\D{0,3}(\d{1,2})(?:\s*月|\s*$)/);
  if (monthOnly) return formatDate(monthOnly[1], monthOnly[2], '1');
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
  let result;
  if (workerData.kind === 'video') {
    const ctx = {
      code: workerData.task && workerData.task.code,
      proxyUrl: workerData.proxyUrl,
      cheerio,
      fetchPage,
      fetchBuffer,
      browser,
      helpers
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
