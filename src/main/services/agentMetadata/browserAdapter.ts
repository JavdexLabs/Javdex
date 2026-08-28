import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import type { AgentMetadataBrowserHandoff, AgentMetadataSource } from '@shared/agentMetadataTypes'
import { getSettings } from '../../settings/settingsStore'
import {
  isScrapeBrowserActionUncertainError,
  isScrapeBrowserChallengeError,
  isScrapeBrowserObservationPendingError,
  scrapeBrowser,
  type AgentBrowserCommand,
  type ScrapeBrowserLease
} from '../../scrapers/scrapeBrowser'
import { AgentBrowserEvidenceModule } from '../../agent-platform/agentBrowserEvidence'
import type { HostedToolResult } from '../../agent-platform/types'

type ReadBrowserAction = Exclude<AgentBrowserCommand['action'], 'fill' | 'press'>

interface ActiveBrowserSession {
  lease: ScrapeBrowserLease
  controller: AbortController
  requestedUrl: string
  allowedHost: string
  workspaceDirectory: string
  finalUrl?: string
  title?: string
}

function browserError(code: string, message: string, extra: Record<string, unknown> = {}): HostedToolResult {
  return {
    ok: false,
    content: JSON.stringify({ code, message, ...extra }, null, 2),
    summary: message,
    recovery: { code, ...extra }
  }
}

function normalizedHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, '')
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true
  }
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
}

function isPrivateAddress(address: string): boolean {
  const ipVersion = net.isIP(address)
  if (ipVersion === 4) return isPrivateIpv4(address)
  if (ipVersion !== 6) return true
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length)
    return net.isIP(mapped) !== 4 || isPrivateIpv4(mapped)
  }
  return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || /^fe[89ab]/u.test(normalized) || normalized.startsWith('ff')
}

function isProxySyntheticDnsAddress(address: string): boolean {
  if (net.isIP(address) !== 4) return false
  const [first, second] = address.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function isSensitiveQueryKey(key: string): boolean {
  return /^(?:access[_-]?token|token|secret|api[_-]?key|key|auth|authorization|signature|credential|policy|expires?)$/iu
    .test(key)
}

type LookupAddress = { address: string }
type LookupAll = (hostname: string) => Promise<LookupAddress[]>

export async function assertAgentMetadataPublicHttpUrl(
  raw: string,
  lookupAll: LookupAll = async (hostname) => lookup(hostname, { all: true, verbatim: true })
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('URL 格式无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) URL')
  if (url.username || url.password) throw new Error('URL 不能包含账号或密码')
  const hostname = url.hostname.toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('不允许访问本机或局域网地址')
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('不允许访问本机或局域网地址')
    return url
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookupAll(hostname)
  } catch {
    throw new Error('无法解析目标站点地址')
  }
  // TUN proxies commonly synthesize domain answers from RFC 2544's 198.18/15 range.
  // Accept that range only for a DNS-backed hostname; direct IP literals were rejected above.
  if (!addresses.length || addresses.some((item) =>
    isPrivateAddress(item.address) && !isProxySyntheticDnsAddress(item.address)
  )) {
    throw new Error('不允许访问本机或局域网地址')
  }
  return url
}

export function sanitizeAgentMetadataUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveQueryKey(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return ''
  }
}

function handoffPrompt(reason: AgentMetadataBrowserHandoff['reason']): string {
  if (reason === 'login') {
    return '当前页面需要登录。请只在已打开的浏览器窗口中完成登录，不要把账号、密码或验证码发送给 Agent。完成后点击继续。'
  }
  if (reason === 'human_verification') {
    return '请在已打开的浏览器窗口中完成人机验证，完成后点击继续。'
  }
  return '当前页面需要你亲自完成必要操作，完成后点击继续。'
}

export class AgentMetadataBrowserAdapter {
  private readonly sessions = new Map<string, ActiveBrowserSession>()
  private readonly evidence = new AgentBrowserEvidenceModule()

  async openSession(input: {
    runId: string
    sourceUrl: string
    workspaceDirectory: string
    signal?: AbortSignal
  }): Promise<void> {
    if (this.sessions.has(input.runId)) return
    const parsed = await assertAgentMetadataPublicHttpUrl(input.sourceUrl)
    input.signal?.throwIfAborted()
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', forwardAbort, { once: true })
    try {
      const lease = await scrapeBrowser.acquire({
        ownerId: `metadata-agent:${input.runId}`,
        purpose: 'agent-browser',
        proxyUrl: resolveScrapeProxyUrl(getSettings()),
        signal: controller.signal
      })
      this.sessions.set(input.runId, {
        lease,
        controller,
        requestedUrl: input.sourceUrl,
        allowedHost: normalizedHost(parsed.hostname),
        workspaceDirectory: input.workspaceDirectory
      })
    } finally {
      input.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  source(runId: string): AgentMetadataSource {
    const session = this.require(runId)
    const finalUrl = session.finalUrl ? sanitizeAgentMetadataUrl(session.finalUrl) : undefined
    const requestedUrl = sanitizeAgentMetadataUrl(session.requestedUrl)
    const sourceUrl = finalUrl || requestedUrl
    let sourceName: string | undefined
    try {
      sourceName = new URL(sourceUrl).hostname.replace(/^www\./u, '')
    } catch {
      sourceName = undefined
    }
    return {
      requestedUrl,
      ...(finalUrl ? { finalUrl } : {}),
      displayUrl: sourceUrl,
      ...(sourceName ? { sourceName } : {}),
      ...(session.title ? { pageTitle: session.title.slice(0, 500) } : {})
    }
  }

  assertEvidenceRefs(runId: string, refs: string[]): void {
    const session = this.require(runId)
    const root = path.resolve(session.workspaceDirectory, '.javdex', 'browser')
    const valid = refs.every((ref) => {
      const resolved = path.resolve(session.workspaceDirectory, ref)
      return resolved.startsWith(`${root}${path.sep}`) && fs.existsSync(resolved)
    })
    if (!valid) throw new Error('浏览器证据引用不存在或不属于当前采集会话。')
  }

  async execute(input: {
    runId: string
    args: Record<string, unknown>
    signal: AbortSignal
    onHandoff: (handoff: AgentMetadataBrowserHandoff) => void
  }): Promise<HostedToolResult> {
    const session = this.require(input.runId)
    input.signal.throwIfAborted()
    const action = typeof input.args.action === 'string' ? input.args.action : ''
    if (action === 'read-section') {
      const artifactRef = typeof input.args.artifactRef === 'string' ? input.args.artifactRef.trim() : ''
      const section = typeof input.args.section === 'string' ? input.args.section.trim() : ''
      if (!artifactRef || !section) return browserError('BROWSER_SECTION_REQUIRED', '缺少 artifactRef 或 section。')
      const result = this.evidence.readSection({
        workspaceDirectory: session.workspaceDirectory,
        artifactRef,
        section,
        ...(typeof input.args.cursor === 'string' ? { cursor: input.args.cursor } : {})
      })
      return {
        ok: result.ok,
        content: result.content,
        summary: result.ok ? `已读取浏览器证据 ${section}` : '浏览器证据读取失败',
        recovery: result.structured
      }
    }
    if (action === 'handoff') {
      const reason = input.args.reason
      if (!['human_verification', 'login', 'required_user_action'].includes(String(reason))) {
        return browserError('BROWSER_HANDOFF_REASON_INVALID', '浏览器交接原因无效。')
      }
      const presentation = await this.runWithSignal(
        session,
        input.signal,
        () => session.lease.presentToUser()
      )
      if (presentation.url) await this.acceptObservedUrl(session, presentation.url)
      session.title = presentation.title
      const handoff: AgentMetadataBrowserHandoff = {
        requestId: `metadata-browser:${randomUUID()}`,
        reason: reason as AgentMetadataBrowserHandoff['reason'],
        prompt: handoffPrompt(reason as AgentMetadataBrowserHandoff['reason']),
        url: sanitizeAgentMetadataUrl(presentation.url),
        title: presentation.title
      }
      input.onHandoff(handoff)
      return {
        ok: true,
        content: JSON.stringify({ code: 'USER_INPUT_REQUIRED', ...handoff }, null, 2),
        summary: '等待用户完成浏览器操作',
        terminate: true,
        recovery: { requestId: handoff.requestId, reason: handoff.reason }
      }
    }
    const allowed = ['open', 'snapshot', 'find', 'html', 'evaluate', 'click', 'wait', 'status']
    if (!allowed.includes(action)) return browserError('BROWSER_ACTION_INVALID', 'browser.action 无效或不允许。')

    const args = { ...input.args }
    delete args.action
    if (action === 'open') {
      const rawUrl = typeof args.url === 'string' ? args.url.trim() : ''
      if (!rawUrl) return browserError('BROWSER_URL_REQUIRED', 'browser action=open 时 url 必填。')
      try {
        // The model receives a redacted display URL. Resolve that exact value back to the
        // user-authorized URL so signed detail links still work without entering the transcript.
        const navigationUrl = rawUrl === sanitizeAgentMetadataUrl(session.requestedUrl)
          ? session.requestedUrl
          : rawUrl
        const url = await assertAgentMetadataPublicHttpUrl(navigationUrl)
        if (normalizedHost(url.hostname) !== session.allowedHost) {
          return browserError('BROWSER_HOST_DENIED', '只能打开用户指定详情页所在站点。')
        }
        args.url = navigationUrl
      } catch (error) {
        return browserError('BROWSER_URL_DENIED', error instanceof Error ? error.message : String(error))
      }
    }

    const commandResult = this.command(action as ReadBrowserAction, args)
    if ('error' in commandResult) return commandResult.error
    try {
      const result = await this.evidence.execute({
        sessionId: input.runId,
        workspaceDirectory: session.workspaceDirectory,
        action: action as ReadBrowserAction,
        args,
        run: async () => {
          const observation = await this.runWithSignal(
            session,
            input.signal,
            () => scrapeBrowser.runWithLease(
              session.lease,
              () => session.lease.agentAction(commandResult.command)
            )
          )
          if (observation.url) {
            await this.acceptObservedUrl(session, observation.url)
          }
          if (observation.title) session.title = observation.title
          const { fullSnapshot, ...compact } = observation
          const safeCompact = observation.url
            ? { ...compact, url: sanitizeAgentMetadataUrl(observation.url) }
            : compact
          return {
            ok: true,
            content: '',
            structured: { observation: safeCompact, ...(fullSnapshot ? { fullSnapshot } : {}) }
          }
        }
      })
      return {
        ok: result.ok,
        content: result.content,
        summary: result.ok ? `浏览器 ${action} 完成` : `浏览器 ${action} 失败`,
        recovery: result.structured
      }
    } catch (error) {
      input.signal.throwIfAborted()
      if (isScrapeBrowserChallengeError(error)) {
        const presentation = await this.runWithSignal(
          session,
          input.signal,
          () => session.lease.presentToUser()
        )
        const presentedUrl = error.url || presentation.url
        if (presentedUrl) await this.acceptObservedUrl(session, presentedUrl)
        const handoff: AgentMetadataBrowserHandoff = {
          requestId: `metadata-browser:${randomUUID()}`,
          reason: 'human_verification',
          prompt: handoffPrompt('human_verification'),
          url: sanitizeAgentMetadataUrl(presentedUrl),
          title: error.title || presentation.title
        }
        input.onHandoff(handoff)
        return {
          ok: true,
          content: JSON.stringify({ code: 'USER_INPUT_REQUIRED', ...handoff }, null, 2),
          summary: '等待用户完成人机验证',
          terminate: true,
          recovery: { requestId: handoff.requestId, reason: handoff.reason }
        }
      }
      if (isScrapeBrowserActionUncertainError(error)) {
        return browserError(error.code, error.message, {
          url: sanitizeAgentMetadataUrl(error.url),
          documentRevision: error.documentRevision,
          nextAction: 'snapshot_or_status'
        })
      }
      if (isScrapeBrowserObservationPendingError(error)) {
        return browserError(error.code, error.message, {
          url: sanitizeAgentMetadataUrl(error.url),
          documentRevision: error.documentRevision,
          nextAction: 'snapshot'
        })
      }
      return browserError('BROWSER_FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  async fetchBuffer(runId: string, rawUrl: string, signal?: AbortSignal): Promise<Buffer> {
    const session = this.require(runId)
    let current = await assertAgentMetadataPublicHttpUrl(rawUrl)
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      signal?.throwIfAborted()
      const response = await this.runWithSignal(
        session,
        signal,
        () => scrapeBrowser.runWithLease(
          session.lease,
          () => session.lease.fetchBufferResponse(current.toString(), {
            referer: 'session',
            maxBytes: 20 * 1024 * 1024,
            redirect: 'manual'
          })
        )
      )
      if (![301, 302, 303, 307, 308].includes(response.statusCode)) return response.body
      if (!response.location || redirectCount === 5) throw new Error('图片重定向无效或次数过多')
      const next = await assertAgentMetadataPublicHttpUrl(
        new URL(response.location, current).toString()
      )
      if (current.protocol === 'https:' && next.protocol !== 'https:') {
        throw new Error('不允许图片链接从 HTTPS 降级到 HTTP')
      }
      current = next
    }
    throw new Error('图片重定向次数过多')
  }

  async release(runId: string, reason = 'Agent metadata collection settled'): Promise<void> {
    this.evidence.reset(runId)
    const session = this.sessions.get(runId)
    if (!session) return
    this.sessions.delete(runId)
    await session.lease.release()
    session.controller.abort(new Error(reason))
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((runId) => this.release(runId)))
  }

  private require(runId: string): ActiveBrowserSession {
    const session = this.sessions.get(runId)
    if (!session) throw new Error('Agent 元数据浏览器会话不存在。')
    return session
  }

  private async acceptObservedUrl(session: ActiveBrowserSession, rawUrl: string): Promise<void> {
    const resolved = await assertAgentMetadataPublicHttpUrl(rawUrl)
    if (normalizedHost(resolved.hostname) !== session.allowedHost) {
      session.controller.abort(new Error('Metadata Agent navigated outside the authorized site'))
      throw new Error('页面跳转到了未授权站点，已终止采集。')
    }
    session.finalUrl = rawUrl
  }

  private async runWithSignal<T>(
    session: ActiveBrowserSession,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    signal?.throwIfAborted()
    const abortSession = (): void => session.controller.abort(signal?.reason)
    signal?.addEventListener('abort', abortSession, { once: true })
    try {
      return await operation()
    } finally {
      signal?.removeEventListener('abort', abortSession)
    }
  }

  private command(
    action: ReadBrowserAction,
    args: Record<string, unknown>
  ): { command: AgentBrowserCommand } | { error: HostedToolResult } {
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    switch (action) {
      case 'open':
        return { command: {
          action,
          url: String(args.url),
          ...(typeof args.readySelector === 'string' ? { readySelector: args.readySelector } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        } }
      case 'snapshot':
        return { command: {
          action,
          ...(target ? { target } : {}),
          ...(typeof args.depth === 'number' ? { depth: Math.round(args.depth) } : {}),
          ...(typeof args.boxes === 'boolean' ? { boxes: args.boxes } : {})
        } }
      case 'find':
        return { command: {
          action,
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.regex === 'string' ? { regex: args.regex } : {})
        } }
      case 'html':
        return { command: {
          action,
          ...(target ? { target } : {}),
          maxLength: typeof args.maxLength === 'number' ? Math.min(20_000, Math.round(args.maxLength)) : 20_000
        } }
      case 'evaluate':
        return { command: {
          action,
          expression: typeof args.expression === 'string' ? args.expression : '',
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        } }
      case 'click':
        return target
          ? { command: { action, target } }
          : { error: browserError('BROWSER_TARGET_REQUIRED', 'browser action=click 时 target 必填。') }
      case 'wait':
        return { command: {
          action,
          ...(target ? { target } : {}),
          ...(typeof args.timeoutMs === 'number' ? { timeoutMs: Math.round(args.timeoutMs) } : {})
        } }
      case 'status':
        return { command: { action } }
    }
  }
}

export const agentMetadataBrowser = new AgentMetadataBrowserAdapter()
