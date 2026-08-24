import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net, { type Server, type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRequire } from 'node:module'
import { APP_PACKAGE_NAME, readTestUserDataPath } from '@shared/appIdentity'
import type { Browser, Locator, Page } from 'playwright-core'
import {
  SCRAPE_BROWSER_HELPER_ENV,
  SCRAPE_BROWSER_HELPER_FLAG,
  ScrapeBrowserFramedSocket,
  assertScrapeBrowserHello,
  type ScrapeBrowserHelloFrame,
  type ScrapeBrowserHelperCommand,
  type ScrapeBrowserProtocolFrame,
  type ScrapeBrowserResponseFrame
} from './scrapeBrowserProtocol'
import {
  prepareBrowserEvaluate,
  runPreparedBrowserEvaluate
} from './scrapeBrowserEvaluatePolicy'
import {
  ScrapeBrowserActionUncertainError,
  ScrapeBrowserChallengeError,
  ScrapeBrowserObservationPendingError,
  type AgentBrowserCommand,
  type AgentBrowserObservation,
  type PluginBrowserAction,
  type ScrapeBrowserFetchBufferOptions,
  type ScrapeBrowserFetchPageOptions,
  type ScrapeBrowserPurpose,
  type ScrapeBrowserResourceResponse
} from './scrapeBrowserTypes'

export {
  ScrapeBrowserActionUncertainError,
  ScrapeBrowserChallengeError,
  ScrapeBrowserObservationPendingError,
  isScrapeBrowserActionUncertainError,
  isScrapeBrowserChallengeError,
  isScrapeBrowserObservationPendingError,
  type AgentBrowserCommand,
  type AgentBrowserObservation,
  type PluginBrowserAction,
  type ScrapeBrowserFetchBufferOptions,
  type ScrapeBrowserFetchPageOptions,
  type ScrapeBrowserPurpose,
  type ScrapeBrowserResourceResponse
} from './scrapeBrowserTypes'

const HELPER_START_TIMEOUT_MS = 12_000
const HELPER_CANCEL_GRACE_MS = 500
const MAX_START_ATTEMPTS = 3
const MAX_AGENT_HTML_LENGTH = 20_000
const DEFAULT_AGENT_RESULT_SNAPSHOT_LENGTH = 2_600
const POST_ACTION_OBSERVATION_TIMEOUT_MS = 3_000
const POST_ACTION_OBSERVATION_ATTEMPTS = 3

interface RunningHelper {
  generation: number
  child: ChildProcess
  server: Server
  pipePath: string
  framed: ScrapeBrowserFramedSocket
  browser: Browser
  page: Page
  targetId: string
  cdpPort: number
  fatal: boolean
  pageEpoch: number
  snapshotEpoch: number | null
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  settledForCaller: boolean
  cancelTimer?: ReturnType<typeof setTimeout>
}

interface ActiveLeaseState {
  ownerId: string
  purpose: ScrapeBrowserPurpose
  proxyUrl?: string
  references: number
  generation: number
}

export interface ScrapeBrowserAcquireInput {
  ownerId: string
  purpose: ScrapeBrowserPurpose
  proxyUrl?: string
  signal: AbortSignal
}

export interface ScrapeBrowserPresentation {
  url: string
  title: string
}

export interface ScrapeBrowserLease {
  readonly ownerId: string
  readonly purpose: ScrapeBrowserPurpose
  fetchPage(url: string, options?: ScrapeBrowserFetchPageOptions): Promise<string>
  fetchBuffer(url: string, options?: ScrapeBrowserFetchBufferOptions): Promise<Buffer>
  fetchBufferResponse(
    url: string,
    options?: ScrapeBrowserFetchBufferOptions
  ): Promise<ScrapeBrowserResourceResponse>
  pluginAction(
    action: PluginBrowserAction,
    params?: Record<string, unknown>
  ): Promise<unknown>
  agentAction(command: AgentBrowserCommand): Promise<AgentBrowserObservation>
  /** Make the helper window visible and focused for an explicit user handoff. */
  presentToUser(): Promise<ScrapeBrowserPresentation>
  recycle(): Promise<void>
  release(): Promise<void>
}

export interface ScrapeBrowserHost {
  acquire(input: ScrapeBrowserAcquireInput): Promise<ScrapeBrowserLease>
  closeSession(): Promise<void>
  dispose(): Promise<void>
}

export class ScrapeBrowserBusyError extends Error {
  readonly code = 'SCRAPE_BROWSER_BUSY' as const
  readonly ownerId: string
  readonly purpose: ScrapeBrowserPurpose

  constructor(active: Pick<ActiveLeaseState, 'ownerId' | 'purpose'>) {
    super(`刮削浏览器正由 ${active.purpose} 使用`)
    this.name = 'ScrapeBrowserBusyError'
    this.ownerId = active.ownerId
    this.purpose = active.purpose
  }
}

export function isScrapeBrowserBusyError(error: unknown): error is ScrapeBrowserBusyError {
  return (error as { code?: unknown } | null)?.code === 'SCRAPE_BROWSER_BUSY'
}

function normalizeProxy(proxyUrl: string | undefined): string | undefined {
  const normalized = proxyUrl?.trim()
  return normalized || undefined
}

function helperPipePath(): string {
  const suffix = crypto.randomBytes(12).toString('hex')
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\javdex-scraper-${process.pid}-${suffix}`
    : path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), `jds-${process.pid}-${suffix}.sock`)
}

function hostAppPath(): string {
  if (app?.getAppPath) return app.getAppPath()
  return process.cwd()
}

function hostUserDataPath(): string {
  if (app?.getPath) return app.getPath('userData')
  const testPath = readTestUserDataPath()
  if (testPath) return path.resolve(testPath)
  if (process.env.JAVDEX_USER_DATA?.trim()) return path.resolve(process.env.JAVDEX_USER_DATA.trim())
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_PACKAGE_NAME)
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_PACKAGE_NAME)
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), APP_PACKAGE_NAME)
}

function electronExecutable(): string {
  if (process.versions.electron) return process.execPath
  const loaded = createRequire(import.meta.url)('electron') as unknown
  if (typeof loaded === 'string' && loaded) return loaded
  throw new Error('无法定位 Electron scraper helper executable')
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('无法预留 scraper helper CDP 端口')
  }
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
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

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('浏览器操作已取消'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function responseError(frame: ScrapeBrowserResponseFrame): Error {
  const source = frame.error
  if (source?.code === 'CHALLENGE') {
    return new ScrapeBrowserChallengeError({ url: source.url, title: source.title })
  }
  const error = new Error(source?.message || 'Scraper helper request failed') as Error & {
    code?: string
  }
  error.name = source?.name || 'Error'
  if (source?.code) error.code = source.code
  return error
}

function byteLimited(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return { value, truncated: false }
  return {
    value: buffer.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, ''),
    truncated: true
  }
}

function selectorForTarget(page: Page, target: string, snapshotFresh: boolean): Locator {
  const normalized = target.trim()
  if (!normalized) throw new Error('浏览器 target 不能为空')
  if (/^(?:f\d+)?e\d+$/.test(normalized)) {
    if (!snapshotFresh) throw new Error('浏览器 ref 已失效，请重新 snapshot')
    return page.locator(`aria-ref=${normalized}`)
  }
  return page.locator(normalized)
}

function uniqueTargetRequiredError(action: string, target: string, count: number): Error {
  return new Error(`${action} target 匹配 ${count} 个元素（${target}）`)
}

async function assertUniqueTarget(
  action: string,
  target: string,
  locator: Locator
): Promise<void> {
  const count = await locator.count()
  if (count !== 1) throw uniqueTargetRequiredError(action, target, count)
}

function compactFind(snapshot: string, matcher: (line: string) => boolean): Array<{
  ref?: string
  text: string
}> {
  const lines = snapshot.split(/\r?\n/)
  const matches: Array<{ ref?: string; text: string }> = []
  for (let index = 0; index < lines.length && matches.length < 20; index += 1) {
    if (!matcher(lines[index])) continue
    const from = Math.max(0, index - 1)
    const to = Math.min(lines.length, index + 2)
    const text = lines.slice(from, to).join('\n').trim()
    const ref = text.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1]
    matches.push({ ...(ref ? { ref } : {}), text })
  }
  return matches
}

function documentRevision(helper: Pick<RunningHelper, 'generation' | 'pageEpoch'>): string {
  return `${helper.generation}:${helper.pageEpoch}`
}

function isTransientObservationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /execution context was destroyed|cannot find context with specified id|most likely because of a navigation|body.*(?:not found|does not match|failed to find)|waiting for locator\(['"]body['"]\)|element is not attached|timeout .* exceeded/i.test(message)
}

/** Owns helper process startup, authenticated RPC, CDP validation and the exclusive lease. */
export class ScrapeBrowserHostModule implements ScrapeBrowserHost {
  private helper: RunningHelper | null = null
  private helperPromise: Promise<RunningHelper> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private activeLease: ActiveLeaseState | null = null
  private pendingAcquire: {
    ownerId: string
    purpose: ScrapeBrowserPurpose
    proxyUrl?: string
    promise: Promise<ActiveLeaseState>
  } | null = null
  private requestSequence = 0
  private generation = 0
  private sessionEpoch = 0
  private sessionClosePromise: Promise<void> | null = null
  private disposed = false
  private readonly leaseContext = new AsyncLocalStorage<ScrapeBrowserLease>()
  private legacyProxyUrl: string | undefined
  private legacyLease: ScrapeBrowserLease | null = null

  async acquire(input: ScrapeBrowserAcquireInput): Promise<ScrapeBrowserLease> {
    if (this.sessionClosePromise) {
      await withAbort(this.sessionClosePromise, input.signal)
    }
    if (this.disposed) throw new Error('ScrapeBrowserHost 已关闭')
    input.signal.throwIfAborted()
    const ownerId = input.ownerId.trim()
    if (!ownerId) throw new Error('刮削浏览器 ownerId 不能为空')
    const proxyUrl = normalizeProxy(input.proxyUrl)
    if (this.activeLease) {
      if (this.activeLease.ownerId !== ownerId) throw new ScrapeBrowserBusyError(this.activeLease)
      if (this.activeLease.proxyUrl !== proxyUrl || this.activeLease.purpose !== input.purpose) {
        throw new Error('同一刮削浏览器租约内不能切换代理或用途')
      }
      this.activeLease.references += 1
      return this.createLease(this.activeLease, input.signal)
    }

    if (this.pendingAcquire) {
      if (this.pendingAcquire.ownerId !== ownerId) {
        throw new ScrapeBrowserBusyError(this.pendingAcquire)
      }
      if (this.pendingAcquire.proxyUrl !== proxyUrl || this.pendingAcquire.purpose !== input.purpose) {
        throw new Error('同一刮削浏览器租约内不能切换代理或用途')
      }
      await this.pendingAcquire.promise
      return this.acquire(input)
    }

    const sessionEpoch = this.sessionEpoch
    const promise = (async (): Promise<ActiveLeaseState> => {
      const helper = await this.ensureHelper(input.signal)
      await this.request('setProxy', { proxyUrl }, input.signal)
      if (this.disposed) throw new Error('ScrapeBrowserHost 已关闭')
      if (sessionEpoch !== this.sessionEpoch) throw new Error('刮削浏览器会话已关闭')
      const state: ActiveLeaseState = {
        ownerId,
        purpose: input.purpose,
        proxyUrl,
        references: 1,
        generation: helper.generation
      }
      this.activeLease = state
      return state
    })()
    const pending = { ownerId, purpose: input.purpose, proxyUrl, promise }
    this.pendingAcquire = pending
    try {
      const lease = this.createLease(await promise, input.signal)
      if (input.purpose === 'scrape' || input.purpose === 'plugin-check') {
        try {
          await lease.presentToUser()
        } catch {
          // Show is best-effort; the scrape lease is already live.
        }
      }
      return lease
    } catch (error) {
      if (!this.activeLease && sessionEpoch === this.sessionEpoch && !this.disposed) {
        void this.stopHelper('acquire failed')
      }
      throw error
    } finally {
      if (this.pendingAcquire === pending) this.pendingAcquire = null
    }
  }

  closeSession(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.sessionClosePromise) return this.sessionClosePromise
    this.sessionEpoch += 1
    this.activeLease = null
    this.legacyLease = null
    const helperPromise = this.helperPromise
    const pendingAcquirePromise = this.pendingAcquire?.promise
    const closePromise = (async (): Promise<void> => {
      await this.stopHelper('host session closed')
      if (helperPromise) await helperPromise.catch(() => undefined)
      await this.stopHelper('host session closed during startup')
      if (pendingAcquirePromise) await pendingAcquirePromise.catch(() => undefined)
      await this.stopHelper('host session closed after acquire')
    })().finally(() => {
      if (this.sessionClosePromise === closePromise) this.sessionClosePromise = null
    })
    this.sessionClosePromise = closePromise
    return closePromise
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      if (this.sessionClosePromise) await this.sessionClosePromise
      return
    }
    this.disposed = true
    this.sessionEpoch += 1
    this.activeLease = null
    this.legacyLease = null
    if (this.sessionClosePromise) await this.sessionClosePromise
    const helperPromise = this.helperPromise
    await this.stopHelper('host disposed')
    if (helperPromise) await helperPromise.catch(() => undefined)
    await this.stopHelper('host disposed during startup')
  }

  runWithLease<T>(lease: ScrapeBrowserLease, run: () => Promise<T>): Promise<T> {
    return this.leaseContext.run(lease, run)
  }

  /** Compatibility surface while callers are migrated to explicit lease ownership. */
  async setProxy(proxyUrl: string | undefined): Promise<void> {
    const normalized = normalizeProxy(proxyUrl)
    if (this.activeLease && this.activeLease.proxyUrl !== normalized) {
      throw new Error('当前刮削浏览器租约的代理已冻结')
    }
    this.legacyProxyUrl = normalized
  }

  async fetchPage(url: string, options?: ScrapeBrowserFetchPageOptions): Promise<string> {
    return (this.leaseContext.getStore() ?? await this.ensureLegacyLease()).fetchPage(url, options)
  }

  async fetchBuffer(url: string, options?: ScrapeBrowserFetchBufferOptions): Promise<Buffer> {
    return (this.leaseContext.getStore() ?? await this.ensureLegacyLease()).fetchBuffer(url, options)
  }

  async fetchBufferResponse(
    url: string,
    options?: ScrapeBrowserFetchBufferOptions
  ): Promise<ScrapeBrowserResourceResponse> {
    return (this.leaseContext.getStore() ?? await this.ensureLegacyLease()).fetchBufferResponse(url, options)
  }

  async performAction(
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<unknown> {
    return (this.leaseContext.getStore() ?? await this.ensureLegacyLease())
      .pluginAction(action as PluginBrowserAction, params)
  }

  close(): void {
    const lease = this.legacyLease
    this.legacyLease = null
    if (lease) void lease.release()
  }

  private async ensureLegacyLease(): Promise<ScrapeBrowserLease> {
    if (this.legacyLease) return this.legacyLease
    if (this.activeLease) {
      throw new ScrapeBrowserBusyError(this.activeLease)
    }
    const lease = await this.acquire({
      ownerId: `legacy:${crypto.randomUUID()}`,
      purpose: 'scrape',
      proxyUrl: this.legacyProxyUrl,
      signal: new AbortController().signal
    })
    this.legacyLease = lease
    return lease
  }

  private createLease(state: ActiveLeaseState, signal: AbortSignal): ScrapeBrowserLease {
    let released = false
    const assertCurrent = (): void => {
      signal.throwIfAborted()
      if (released || this.activeLease !== state || this.helper?.generation !== state.generation) {
        throw new Error('刮削浏览器租约已失效')
      }
    }
    const rpc = async <T>(
      command: ScrapeBrowserHelperCommand,
      payload: Record<string, unknown>
    ): Promise<T> => {
      assertCurrent()
      return this.request(command, payload, signal) as Promise<T>
    }
    return {
      ownerId: state.ownerId,
      purpose: state.purpose,
      fetchPage: (url, options) => rpc<string>('fetchPage', { url, options }),
      fetchBuffer: (url, options) => rpc<Buffer>('fetchBuffer', { url, options }),
      fetchBufferResponse: (url, options) =>
        rpc<ScrapeBrowserResourceResponse>('fetchBufferResponse', { url, options }),
      pluginAction: (action, params = {}) => rpc('performAction', { action, params }),
      presentToUser: async () => {
        const status = await rpc<{ url?: unknown; title?: unknown }>('performAction', {
          action: 'present',
          params: {}
        })
        return {
          url: typeof status.url === 'string' ? status.url : '',
          title: typeof status.title === 'string' ? status.title : ''
        }
      },
      agentAction: async (command) => {
        assertCurrent()
        try {
          return await withAbort(this.runAgentAction(command, signal), signal)
        } catch (error) {
          if (signal.aborted) await this.stopHelper('agent action aborted')
          throw error
        }
      },
      recycle: async () => {
        assertCurrent()
        await this.stopHelper('lease recycle')
        const helper = await this.ensureHelper(signal)
        await this.request('setProxy', { proxyUrl: state.proxyUrl }, signal)
        state.generation = helper.generation
      },
      release: async () => {
        if (released) return
        released = true
        if (this.activeLease !== state) return
        state.references -= 1
        if (state.references > 0) return
        this.activeLease = null
        if (this.legacyLease?.ownerId === state.ownerId) this.legacyLease = null
        await this.stopHelper('lease released')
      }
    }
  }

  private async ensureHelper(signal: AbortSignal): Promise<RunningHelper> {
    signal.throwIfAborted()
    if (this.helper && !this.helper.fatal) return this.helper
    if (!this.helperPromise) {
      this.helperPromise = this.startHelperWithRetries().finally(() => {
        this.helperPromise = null
      })
    }
    return withTimeout(this.helperPromise, HELPER_START_TIMEOUT_MS * MAX_START_ATTEMPTS, 'Scraper helper 启动超时')
  }

  private async startHelperWithRetries(): Promise<RunningHelper> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      try {
        return await this.startHelper()
      } catch (error) {
        lastError = error
        await this.stopHelper(`start attempt ${attempt} failed`)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Scraper helper 无法启动')
  }

  private async startHelper(): Promise<RunningHelper> {
    const token = crypto.randomBytes(32).toString('hex')
    const pipePath = helperPipePath()
    const cdpPort = await reserveLoopbackPort()
    const server = net.createServer()
    const socketPromise = new Promise<Socket>((resolve, reject) => {
      server.once('connection', resolve)
      server.once('error', reject)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipePath, resolve)
    })

    const args = process.defaultApp || !process.versions.electron
      ? [hostAppPath(), SCRAPE_BROWSER_HELPER_FLAG]
      : [SCRAPE_BROWSER_HELPER_FLAG]
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env[SCRAPE_BROWSER_HELPER_ENV.pipe] = pipePath
    env[SCRAPE_BROWSER_HELPER_ENV.token] = token
    env[SCRAPE_BROWSER_HELPER_ENV.profile] = path.join(hostUserDataPath(), 'Partitions', 'scraper')
    env[SCRAPE_BROWSER_HELPER_ENV.cdpPort] = String(cdpPort)
    env[SCRAPE_BROWSER_HELPER_ENV.parentPid] = String(process.pid)
    const child = spawn(electronExecutable(), args, {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      // CREATE_NO_WINDOW hides the helper BrowserWindow on Windows.
      windowsHide: false
    })
    child.stderr?.on('data', (data: Buffer) => {
      const rawMessage = data.toString('utf8').trim()
      const message = rawMessage.includes('DevTools listening on')
        ? 'DevTools listening (loopback endpoint redacted)'
        : rawMessage
        .replaceAll(token, '[redacted-token]')
        .replaceAll(pipePath, '[redacted-pipe]')
        .replaceAll(env[SCRAPE_BROWSER_HELPER_ENV.profile]!, '[redacted-profile]')
        .replaceAll(`127.0.0.1:${cdpPort}`, '[redacted-cdp]')
      if (message) console.error(`[scraper-helper] ${message.slice(0, 2000)}`)
    })

    const framedHolder: { value?: ScrapeBrowserFramedSocket } = {}
    try {
      const socket = await withTimeout(socketPromise, HELPER_START_TIMEOUT_MS, 'Scraper helper IPC 连接超时')
      if (server.listening) server.close()
      const helloPromise = new Promise<ScrapeBrowserHelloFrame>((resolve, reject) => {
        framedHolder.value = new ScrapeBrowserFramedSocket(
          socket,
          (frame) => {
            if (frame.type === 'hello') {
              resolve(frame)
              return
            }
            this.handleFrame(frame)
          },
          reject
        )
      })
      const hello = await withTimeout(helloPromise, HELPER_START_TIMEOUT_MS, 'Scraper helper 握手超时')
      const framed = framedHolder.value
      if (!framed) throw new Error('Scraper helper IPC 尚未建立')
      assertScrapeBrowserHello(hello, {
        token,
        parentPid: process.pid,
        cdpPort,
        childPid: child.pid
      })

      const targets = await this.readCdpTargets(cdpPort)
      const pages = targets.filter((target) => target.type === 'page')
      if (pages.length !== 1 || pages[0].id !== hello.targetId) {
        throw new Error('Scraper helper CDP target 校验失败')
      }
      const { chromium } = await import('playwright-core')
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
      const contexts = browser.contexts()
      const playwrightPages = contexts.flatMap((context) => context.pages())
      if (contexts.length !== 1 || playwrightPages.length !== 1) {
        await browser.close()
        throw new Error('Scraper helper 只允许一个页面 target')
      }
      const page = playwrightPages[0]
      page.setDefaultTimeout(10_000)
      const generation = ++this.generation
      const helper: RunningHelper = {
        generation,
        child,
        server,
        pipePath,
        framed,
        browser,
        page,
        targetId: hello.targetId,
        cdpPort,
        fatal: false,
        pageEpoch: 0,
        snapshotEpoch: null
      }
      this.helper = helper
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          helper.pageEpoch += 1
          helper.snapshotEpoch = null
        }
      })
      page.on('close', () => this.markHelperFatal(helper, 'Scraper helper page target closed'))
      for (const context of contexts) {
        context.on('page', (newPage) => {
          if (newPage !== page) this.markHelperFatal(helper, 'Scraper helper created an extra page target')
        })
      }
      browser.on('disconnected', () => this.markHelperFatal(helper, 'Scraper helper CDP disconnected'))
      child.once('exit', () => this.markHelperFatal(helper, 'Scraper helper exited'))
      return helper
    } catch (error) {
      framedHolder.value?.close()
      if (server.listening) server.close()
      if (!child.killed) child.kill('SIGKILL')
      if (process.platform !== 'win32') fs.rmSync(pipePath, { force: true })
      throw error
    }
  }

  private async readCdpTargets(cdpPort: number): Promise<Array<{ id: string; type: string }>> {
    let lastError: unknown
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
        if (!response.ok) throw new Error(`CDP HTTP ${response.status}`)
        return await response.json() as Array<{ id: string; type: string }>
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw lastError instanceof Error ? lastError : new Error('无法读取 scraper helper CDP targets')
  }

  private handleFrame(frame: ScrapeBrowserProtocolFrame): void {
    if (frame.type === 'response') {
      const pending = this.pending.get(frame.id)
      if (!pending) return
      this.pending.delete(frame.id)
      if (pending.cancelTimer) clearTimeout(pending.cancelTimer)
      if (pending.settledForCaller) return
      pending.settledForCaller = true
      if (frame.ok) pending.resolve(frame.value)
      else pending.reject(responseError(frame))
      return
    }
    if (frame.type === 'event') {
      const helper = this.helper
      if (helper) this.markHelperFatal(helper, frame.message)
    }
  }

  private request(
    command: ScrapeBrowserHelperCommand,
    payload: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    signal.throwIfAborted()
    const helper = this.helper
    if (!helper || helper.fatal) return Promise.reject(new Error('Scraper helper 不可用'))
    const id = `${helper.generation}:${++this.requestSequence}`
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, settledForCaller: false }
      this.pending.set(id, pending)
      const onAbort = (): void => {
        if (pending.settledForCaller) return
        pending.settledForCaller = true
        reject(signal.reason instanceof Error ? signal.reason : new Error('浏览器操作已取消'))
        try {
          helper.framed.send({ type: 'cancel', id, reason: 'parent signal aborted' })
        } catch {
          // Helper termination below handles a broken pipe.
        }
        pending.cancelTimer = setTimeout(() => {
          if (this.pending.has(id)) void this.stopHelper('cancel grace exceeded')
        }, HELPER_CANCEL_GRACE_MS)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      const settle = (fn: typeof resolve | typeof reject, value: unknown): void => {
        signal.removeEventListener('abort', onAbort)
        fn(value as never)
      }
      pending.resolve = (value) => settle(resolve, value)
      pending.reject = (error) => settle(reject, error)
      try {
        helper.framed.send({ type: 'request', id, command, payload })
      } catch (error) {
        this.pending.delete(id)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private markHelperFatal(helper: RunningHelper, message: string): void {
    if (helper.fatal) return
    helper.fatal = true
    const error = new Error(message)
    for (const [id, pending] of this.pending) {
      if (!id.startsWith(`${helper.generation}:`)) continue
      this.pending.delete(id)
      if (pending.cancelTimer) clearTimeout(pending.cancelTimer)
      if (!pending.settledForCaller) pending.reject(error)
    }
    if (this.activeLease?.generation === helper.generation) this.activeLease = null
    void this.stopHelper(message)
  }

  private async stopHelper(_reason: string): Promise<void> {
    const helper = this.helper
    this.helper = null
    if (!helper) return
    helper.fatal = true
    const exited = new Promise<void>((resolve) => helper.child.once('exit', () => resolve()))
    try {
      helper.framed.send({
        type: 'request',
        id: `${helper.generation}:shutdown`,
        command: 'shutdown',
        payload: {}
      })
    } catch {
      // Already disconnected.
    }
    if (_reason !== 'cancel grace exceeded' && helper.child.exitCode === null) {
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, HELPER_CANCEL_GRACE_MS))
      ])
    }
    helper.framed.close()
    try {
      await helper.browser.close()
    } catch {
      // Browser may already be gone.
    }
    if (helper.server.listening) helper.server.close()
    if (helper.child.exitCode === null && !helper.child.killed) helper.child.kill('SIGKILL')
    if (process.platform !== 'win32') fs.rmSync(helper.pipePath, { force: true })
    const error = new Error('Scraper helper 已终止')
    for (const [id, pending] of this.pending) {
      if (!id.startsWith(`${helper.generation}:`)) continue
      this.pending.delete(id)
      if (pending.cancelTimer) clearTimeout(pending.cancelTimer)
      if (!pending.settledForCaller) pending.reject(error)
    }
  }

  private async snapshot(
    helper: RunningHelper,
    command: Extract<AgentBrowserCommand, { action: 'snapshot' }>,
    signal: AbortSignal,
    timeoutMs = 10_000
  ): Promise<AgentBrowserObservation> {
    const deadline = Date.now() + timeoutMs
    const locator = command.target
      ? selectorForTarget(helper.page, command.target, helper.snapshotEpoch === helper.pageEpoch)
      : helper.page.locator('body')
    if (command.target) await assertUniqueTarget('snapshot', command.target, locator)
    const raw = await locator.ariaSnapshot({
      mode: 'ai',
      ...(command.depth === undefined ? {} : { depth: Math.max(1, Math.min(50, command.depth)) }),
      boxes: command.boxes === true,
      signal,
      timeout: timeoutMs
    })
    let pageFacts: Record<string, unknown> | undefined
    try {
      const remaining = Math.max(1, deadline - Date.now())
      const inspected = await withTimeout(
        this.request('performAction', {
          action: 'inspect',
          params: {
            maxLinks: 120,
            maxTextLength: 12_000,
            maxRegionHtmlLength: 4_000
          }
        }, signal),
        Math.max(1, Math.min(1_000, Math.floor(remaining / 2))),
        '页面事实暂时无法提取'
      )
      if (inspected && typeof inspected === 'object' && !Array.isArray(inspected)) {
        pageFacts = inspected as Record<string, unknown>
      }
    } catch {
      signal.throwIfAborted()
      // ARIA remains usable if optional fact extraction fails on unusual pages.
    }
    helper.snapshotEpoch = helper.pageEpoch
    const compact = byteLimited(raw, DEFAULT_AGENT_RESULT_SNAPSHOT_LENGTH)
    const title = await withTimeout(
      helper.page.title(),
      Math.max(1, deadline - Date.now()),
      'Timeout 1ms exceeded while reading page title'
    )
    return {
      action: 'snapshot',
      documentRevision: documentRevision(helper),
      actionSucceeded: true,
      url: helper.page.url(),
      title,
      snapshot: compact.value,
      fullSnapshot: raw,
      ...(pageFacts ? { pageFacts } : {}),
      snapshotExcerpted: compact.truncated,
      evidenceIncomplete: !pageFacts,
      fullSnapshotTruncated: false
    }
  }

  private async observePage(input: {
    helper: RunningHelper
    action: AgentBrowserObservation['action']
    command?: Extract<AgentBrowserCommand, { action: 'snapshot' }>
    signal: AbortSignal
    beforeRevision: string
    actionSucceeded?: boolean
  }): Promise<AgentBrowserObservation> {
    const deadline = Date.now() + POST_ACTION_OBSERVATION_TIMEOUT_MS
    let lastError: unknown
    for (let attempt = 0; attempt < POST_ACTION_OBSERVATION_ATTEMPTS; attempt += 1) {
      input.signal.throwIfAborted()
      const remaining = Math.max(1, deadline - Date.now())
      if (remaining <= 1 && attempt > 0) break
      try {
        if (documentRevision(input.helper) !== input.beforeRevision) {
          await input.helper.page.waitForLoadState('domcontentloaded', {
            timeout: remaining
          })
        }
        await input.helper.page.locator('body').waitFor({
          state: 'attached',
          timeout: Math.max(1, deadline - Date.now())
        })
        const observation = await this.snapshot(
          input.helper,
          input.command ?? { action: 'snapshot' },
          input.signal,
          Math.max(1, deadline - Date.now())
        )
        return {
          ...observation,
          action: input.action,
          ...(input.actionSucceeded === undefined
            ? {}
            : { actionSucceeded: input.actionSucceeded }),
          staleRefs: documentRevision(input.helper) !== input.beforeRevision
        }
      } catch (error) {
        input.signal.throwIfAborted()
        if (!isTransientObservationError(error)) throw error
        lastError = error
        if (Date.now() >= deadline) break
        await input.helper.page.waitForTimeout(Math.min(75, Math.max(1, deadline - Date.now())))
      }
    }
    const revision = documentRevision(input.helper)
    if (input.actionSucceeded !== true) {
      throw new ScrapeBrowserObservationPendingError({
        url: input.helper.page.url(),
        documentRevision: revision
      })
    }
    return {
      action: input.action,
      documentRevision: revision,
      observationMode: 'pending',
      actionSucceeded: true,
      url: input.helper.page.url(),
      staleRefs: revision !== input.beforeRevision,
      observationPendingReason: lastError instanceof Error ? lastError.message : undefined
    }
  }

  private async performAgentAction(
    helper: RunningHelper,
    action: AgentBrowserObservation['action'],
    signal: AbortSignal,
    run: () => Promise<void>
  ): Promise<AgentBrowserObservation> {
    const beforeRevision = documentRevision(helper)
    if (action === 'click' || action === 'fill' || action === 'press' || action === 'wait') {
      try {
        await this.request('performAction', { action: 'beginNetworkCapture', params: {} }, signal)
      } catch {
        signal.throwIfAborted()
      }
    }
    try {
      await run()
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof ScrapeBrowserChallengeError) throw error
      const revision = documentRevision(helper)
      if (revision !== beforeRevision) {
        throw new ScrapeBrowserActionUncertainError({
          url: helper.page.url(),
          documentRevision: revision,
          cause: error
        })
      }
      throw error
    }
    return this.observePage({
      helper,
      action,
      signal,
      beforeRevision,
      actionSucceeded: true
    })
  }

  private async runAgentAction(
    command: AgentBrowserCommand,
    signal: AbortSignal
  ): Promise<AgentBrowserObservation> {
    const helper = this.helper
    if (!helper || helper.fatal) throw new Error('Scraper helper 不可用')
    switch (command.action) {
      case 'open': {
        return this.performAgentAction(helper, 'open', signal, async () => {
          await this.request('fetchPage', {
            url: command.url,
            discardBody: true,
            options: {
              readySelector: command.readySelector,
              timeoutMs: command.timeoutMs,
              returnOnChallenge: true
            }
          }, signal)
        })
      }
      case 'snapshot': {
        const revision = documentRevision(helper)
        return this.observePage({
          helper,
          action: 'snapshot',
          command,
          signal,
          beforeRevision: revision,
          actionSucceeded: undefined
        })
      }
      case 'find': {
        if (Boolean(command.text) === Boolean(command.regex)) {
          throw new Error('find 的 text 和 regex 必须且只能提供一个')
        }
        const revision = documentRevision(helper)
        const observation = await this.observePage({
          helper,
          action: 'snapshot',
          signal,
          beforeRevision: revision,
          actionSucceeded: undefined
        })
        const full = String(observation.fullSnapshot ?? observation.snapshot ?? '')
        let matcher: (line: string) => boolean
        if (command.text) {
          const needle = command.text.normalize('NFKC').toLocaleLowerCase()
          matcher = (line) => line.normalize('NFKC').toLocaleLowerCase().includes(needle)
        } else {
          if ((command.regex?.length ?? 0) > 256) throw new Error('find regex 最长为 256 字符')
          const regex = new RegExp(command.regex ?? '', 'iu')
          matcher = (line) => regex.test(line)
        }
        return {
          action: 'find',
          documentRevision: documentRevision(helper),
          actionSucceeded: true,
          url: helper.page.url(),
          title: await helper.page.title(),
          matches: compactFind(full, matcher)
        }
      }
      case 'html': {
        const locator = command.target
          ? selectorForTarget(helper.page, command.target, helper.snapshotEpoch === helper.pageEpoch)
          : helper.page.locator('body')
        if (command.target) await assertUniqueTarget('html', command.target, locator)
        const maxLength = Math.max(200, Math.min(MAX_AGENT_HTML_LENGTH, command.maxLength ?? 12_000))
        const raw = await locator.evaluate((element) => element.outerHTML)
        const limited = byteLimited(raw, maxLength)
        return {
          action: 'html',
          documentRevision: documentRevision(helper),
          actionSucceeded: true,
          url: helper.page.url(),
          html: limited.value,
          evidenceIncomplete: limited.truncated
        }
      }
      case 'evaluate': {
        const prepared = prepareBrowserEvaluate(command.expression, command.timeoutMs)
        const value = await runPreparedBrowserEvaluate({
          execute: () => helper.page.evaluate(prepared.source),
          timeoutMs: prepared.timeoutMs,
          onTimeout: () => this.stopHelper('agent evaluate timeout')
        })
        return {
          action: 'evaluate',
          documentRevision: documentRevision(helper),
          actionSucceeded: true,
          url: helper.page.url(),
          value
        }
      }
      case 'click': {
        const locator = selectorForTarget(
          helper.page,
          command.target,
          helper.snapshotEpoch === helper.pageEpoch
        )
        await assertUniqueTarget('click', command.target, locator)
        return this.performAgentAction(helper, 'click', signal, async () => {
          await locator.click({ signal })
        })
      }
      case 'fill': {
        const locator = selectorForTarget(
          helper.page,
          command.target,
          helper.snapshotEpoch === helper.pageEpoch
        )
        await assertUniqueTarget('fill', command.target, locator)
        return this.performAgentAction(helper, 'fill', signal, async () => {
          await locator.fill(command.text, { signal })
          if (command.submit) await locator.press('Enter', { signal })
        })
      }
      case 'press': {
        const press = async (): Promise<void> => {
          if (command.target) {
            const locator = selectorForTarget(
              helper.page,
              command.target,
              helper.snapshotEpoch === helper.pageEpoch
            )
            await assertUniqueTarget('press', command.target, locator)
            await locator.press(command.key, { signal })
          } else {
            await helper.page.keyboard.press(command.key)
          }
        }
        return this.performAgentAction(helper, 'press', signal, press)
      }
      case 'wait': {
        const timeoutMs = Math.max(100, Math.min(10_000, command.timeoutMs ?? 3_000))
        return this.performAgentAction(helper, 'wait', signal, async () => {
          if (command.target) {
            const locator = selectorForTarget(
              helper.page,
              command.target,
              helper.snapshotEpoch === helper.pageEpoch
            )
            await locator.waitFor({ state: 'visible', timeout: timeoutMs })
            await assertUniqueTarget('wait', command.target, locator)
          } else {
            await helper.page.waitForTimeout(timeoutMs)
          }
        })
      }
      case 'status': {
        const value = await this.request('performAction', { action: 'status', params: {} }, signal)
        return { action: 'status', ...(value as Record<string, unknown>) }
      }
    }
  }
}

export const scrapeBrowser = new ScrapeBrowserHostModule()
