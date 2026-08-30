import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { truncateUnicode } from '@shared/unicodeText'
import type {
  AgentSession,
  AgentSessionEvent,
  InlineExtension,
  SessionManager as PiSessionManager,
  ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type {
  AgentOperationId,
  AgentRuntimePort,
  ExecutionHistoryFrame,
  MessageAuditView,
  NormalizedModelUsage,
  OpaqueRuntimeSessionRef,
  RuntimeDurableObservation,
  RuntimeObserver,
  RuntimeRecoveryFrame,
  RuntimeSessionInit,
  RuntimeSessionInitWithoutResume,
  RuntimeSessionPort
} from '../../agent-platform/types'

const RECOVERY_CODEC_VERSION = 1 as const

type PiModule = typeof import('./piSdk')
let piModule: Promise<PiModule> | null = null

function loadPi(): Promise<PiModule> {
  piModule ??= import('./piSdk')
  return piModule
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isWithinDirectory(rootInput: string, candidateInput: string): boolean {
  const root = fs.realpathSync.native(path.resolve(rootInput))
  const candidate = path.resolve(root, candidateInput.replace(/^@/, ''))
  let existing = candidate
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return false
    existing = parent
  }
  const realExisting = fs.realpathSync.native(existing)
  return realExisting === root || realExisting.startsWith(`${root}${path.sep}`)
}

export function validatePluginWorkspaceToolAccess(
  root: string,
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  if (toolName === 'bash') {
    return '插件开发工作区未启用 shell；请使用原生文件工具和 plugin_dry_run。'
  }
  if (!['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(toolName)) return undefined
  const rawPath = input.path
  if (rawPath !== undefined && typeof rawPath !== 'string') {
    return '文件工具 path 必须是字符串。'
  }
  const candidatePath = typeof rawPath === 'string' && rawPath ? rawPath : '.'
  if (!isWithinDirectory(root, candidatePath)) {
    return '拒绝访问插件隔离工作区之外的路径。'
  }
  if (toolName === 'write' || toolName === 'edit') {
    const resolvedRoot = fs.realpathSync.native(path.resolve(root))
    const resolvedTarget = path.resolve(resolvedRoot, candidatePath.replace(/^@/, ''))
    const writable = new Set([
      path.join(resolvedRoot, 'plugin.json'),
      path.join(resolvedRoot, 'index.js'),
      path.join(resolvedRoot, '.javdex', 'dev-notes.md')
    ])
    if (!writable.has(resolvedTarget)) {
      return '只允许修改工作区根目录的 plugin.json、index.js 和 .javdex/dev-notes.md。'
    }
  }
  return undefined
}

function workspaceGuardExtension(root: string): InlineExtension {
  return (pi) => {
    pi.on('tool_call', (event) => {
      const reason = validatePluginWorkspaceToolAccess(
        root,
        event.toolName,
        event.input as Record<string, unknown>
      )
      if (reason) return { block: true, terminate: true, reason }
    })
  }
}

function recovery(kind: 'message' | 'tool-result', value: unknown): RuntimeRecoveryFrame {
  const payload = JSON.stringify({ kind, value })
  return { codecVersion: RECOVERY_CODEC_VERSION, payload, contentHash: sha256(payload) }
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return ''
      const record = item as Record<string, unknown>
      if (record.type === 'text' || record.type === 'thinking') return typeof record.text === 'string' ? record.text : ''
      if (record.type === 'toolCall') return `[tool:${String(record.name ?? '')}]`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function messageAudit(message: unknown): MessageAuditView {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : {}
  const rawRole = typeof record.role === 'string' ? record.role : 'other'
  const role: 'user' | 'assistant' | 'tool' | 'other' =
    rawRole === 'user' || rawRole === 'assistant'
      ? rawRole
      : rawRole === 'toolResult'
        ? 'tool'
        : 'other'
  const content = Array.isArray(record.content) ? record.content : []
  let text = ''
  let textChars = 0
  let reasoningChars = 0
  let toolCallCount = 0
  const contentTypes: string[] = []
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const block = item as Record<string, unknown>
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    contentTypes.push(type)
    if (type === 'text' && typeof block.text === 'string') {
      text += `${text ? '\n' : ''}${block.text}`
      textChars += block.text.length
    } else if (type === 'thinking') {
      const thinking = typeof block.thinking === 'string'
        ? block.thinking
        : typeof block.text === 'string'
          ? block.text
          : ''
      reasoningChars += thinking.length
    } else if (type === 'toolCall') {
      toolCallCount += 1
    }
  }
  return {
    role,
    textPreview: truncateUnicode(text, 500),
    contentHash: sha256(JSON.stringify(message)),
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined,
    rawStopReason: typeof record.rawStopReason === 'string' ? record.rawStopReason : undefined,
    textChars,
    reasoningChars,
    toolCallCount,
    contentTypes
  }
}

function usageFromMessage(message: unknown): Record<string, unknown> | undefined {
  if (!message || typeof message !== 'object') return undefined
  const usage = (message as Record<string, unknown>).usage
  return usage && typeof usage === 'object' ? usage as Record<string, unknown> : undefined
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizedUsage(
  input: RuntimeSessionInit,
  role: 'primary' | 'summarizer',
  usage: Record<string, unknown>
): NormalizedModelUsage {
  const cost = usage.cost && typeof usage.cost === 'object'
    ? usage.cost as Record<string, unknown>
    : {}
  const cacheRead = number(usage.cacheRead)
  const cacheWrite = number(usage.cacheWrite)
  const uncachedInput = number(usage.input)
  const affinity = role === 'summarizer' ? input.cache.summarizerAffinityId : input.cache.primaryAffinityId
  return {
    role,
    routeRevision: input.model.routeRevision,
    affinityHash: sha256(affinity),
    cacheRetention: input.cache.retention[role],
    input: uncachedInput,
    uncachedInput,
    output: number(usage.output),
    reasoning: number(usage.reasoning),
    cacheRead,
    cacheWrite,
    totalInput: uncachedInput + cacheRead + cacheWrite,
    totalTokens: number(usage.totalTokens) || uncachedInput + cacheRead + cacheWrite + number(usage.output),
    cost: number(cost.total),
    missedCost: null,
    ...(role === 'summarizer' ? { breakReason: 'compaction' as const } : {})
  }
}

class DurableObservationQueue {
  private tail: Promise<void> = Promise.resolve()
  private failed: Error | null = null
  private abortRuntime: (() => Promise<void>) | null = null

  constructor(private readonly observer: RuntimeObserver) {}

  setAbortRuntime(abort: () => Promise<void>): void {
    this.abortRuntime = abort
  }

  enqueue(event: RuntimeDurableObservation): Promise<void> {
    const committed = this.tail.then(async () => {
      if (this.failed) throw this.failed
      try {
        await this.observer.commit(event)
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error))
        this.observer.notify({
          type: 'runtime.fault',
          category: 'persistence-failed',
          message: this.failed.message
        })
        await this.abortRuntime?.()
        throw this.failed
      }
    })
    this.tail = committed.catch(() => undefined)
    return committed
  }

  async drain(): Promise<void> {
    await this.tail
    if (this.failed) throw this.failed
  }
}

function safeSessionFile(session: AgentSession): string {
  const file = session.sessionFile
  if (!file) throw new Error('Pi SessionManager 没有创建持久化 session file')
  return file
}

function makeRef(session: AgentSession): OpaqueRuntimeSessionRef {
  return {
    runtimeId: 'pi',
    sessionId: session.sessionId,
    sessionFile: safeSessionFile(session),
    codecVersion: RECOVERY_CODEC_VERSION
  }
}

function assertResumeRef(ref: OpaqueRuntimeSessionRef, sessionDirectory: string): void {
  if (ref.runtimeId !== 'pi' || ref.codecVersion !== RECOVERY_CODEC_VERSION) {
    throw new Error('checkpoint-incompatible: unsupported runtime session ref')
  }
  const root = path.resolve(sessionDirectory)
  const target = path.resolve(ref.sessionFile)
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('checkpoint-corrupt: session file escapes controlled directory')
  }
  if (!fs.existsSync(target)) throw new Error('checkpoint-corrupt: session file is missing')
}

async function createControlledModelRuntime(input: RuntimeSessionInit) {
  const { ModelRuntime } = await loadPi()
  const runtimeProviderId = `javdex-${sha256(`${input.model.model.providerId}\0${input.model.routeRevision}`).slice(0, 24)}`
  const readCredential = async (providerId: string) => {
    if (providerId !== runtimeProviderId) return undefined
    const lease = await input.model.getCredentialLease()
    try {
      return { type: 'api_key' as const, key: lease.resolve() }
    } finally {
      lease.revoke()
    }
  }
  const credentials = {
    read: readCredential,
    async list() {
      return [{ providerId: runtimeProviderId, type: 'api_key' as const }]
    },
    async modify(
      providerId: string,
      fn: (current: { type: 'api_key'; key?: string } | undefined) => Promise<{ type: 'api_key'; key?: string } | undefined>
    ) {
      const current = await readCredential(providerId)
      await fn(current)
      return current
    },
    async delete() {
      throw new Error('Pi runtime credentials are read-only leases')
    }
  }
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false
  })
  const compat = input.model.model.api === 'anthropic-messages'
    ? {
        supportsLongCacheRetention: input.model.cacheCompatibility.supportsLongCacheRetention,
        sendSessionAffinityHeaders: input.model.cacheCompatibility.sendSessionAffinityHeaders
      }
    : {
        supportsLongCacheRetention: input.model.cacheCompatibility.supportsLongCacheRetention,
        sendSessionAffinityHeaders: input.model.cacheCompatibility.sendSessionAffinityHeaders,
        sessionAffinityFormat: input.model.cacheCompatibility.sessionAffinityFormat,
        cacheControlFormat: input.model.cacheCompatibility.cacheControlFormat
      }
  modelRuntime.registerProvider(runtimeProviderId, {
    name: `Javdex ${input.model.model.providerId}`,
    baseUrl: input.model.model.baseUrl,
    api: input.model.model.api,
    models: [
      {
        id: input.model.model.modelId,
        name: input.model.model.name,
        api: input.model.model.api,
        baseUrl: input.model.model.baseUrl,
        reasoning: input.model.model.reasoning,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: input.model.model.contextWindow,
        maxTokens: input.model.model.maxTokens,
        compat
      }
    ]
  })
  const model = modelRuntime.getModel(runtimeProviderId, input.model.model.modelId)
  if (!model) throw new Error('Pi ModelRuntime 未注册解析后的模型')
  return { modelRuntime, model }
}

async function createControlledResources(input: RuntimeSessionInit) {
  const { DefaultResourceLoader, SettingsManager } = await loadPi()
  if (sha256(input.systemPrompt.text) !== input.systemPrompt.sha256) {
    throw new Error('Javdex system prompt hash mismatch')
  }
  const agentDir = path.join(input.sessionDirectory, 'controlled-agent-dir')
  fs.mkdirSync(agentDir, { recursive: true })
  const skillNames = new Set(input.resources?.skillNames ?? [])
  for (const skillName of skillNames) {
    const expectedHash = input.resources?.skillHashes?.[skillName]
    if (!expectedHash) continue
    const skillPath = path.join(input.sessionDirectory, '.agents', 'skills', skillName, 'SKILL.md')
    if (!fs.existsSync(skillPath) || sha256(fs.readFileSync(skillPath, 'utf8')) !== expectedHash) {
      throw new Error(`Pi frozen Skill hash mismatch: ${skillName}`)
    }
  }
  const nativeTools = input.resources?.nativeTools ?? []
  if (nativeTools.includes('bash')) {
    throw new Error('Pi 原生 bash 必须由独立系统沙箱承载，当前 Adapter 拒绝启用')
  }
  const settingsManager = SettingsManager.inMemory({
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    compaction: input.settings.compaction,
    retry: input.settings.retry,
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    enableSkillCommands: skillNames.size > 0,
    defaultTools: []
  }, { projectTrusted: false })
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.sessionDirectory,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: skillNames.size === 0,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: input.systemPrompt.text,
    appendSystemPrompt: [],
    additionalSkillPaths: skillNames.size > 0
      ? [path.join(input.sessionDirectory, '.agents', 'skills')]
      : [],
    extensionFactories: nativeTools.length > 0
      ? [workspaceGuardExtension(input.sessionDirectory)]
      : [],
    skillsOverride: (current) => ({
      skills: current.skills.filter((skill) =>
        skillNames.has(skill.name) &&
        isWithinDirectory(input.sessionDirectory, skill.filePath)
      ),
      diagnostics: current.diagnostics
    }),
    promptsOverride: () => ({ prompts: [], diagnostics: [] }),
    themesOverride: () => ({ themes: [], diagnostics: [] }),
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => input.systemPrompt.text,
    appendSystemPromptOverride: () => []
  })
  await resourceLoader.reload()
  if (
    resourceLoader.getExtensions().extensions.length !== (nativeTools.length > 0 ? 1 : 0) ||
    resourceLoader.getPrompts().prompts.length !== 0 ||
    resourceLoader.getThemes().themes.length !== 0 ||
    resourceLoader.getAgentsFiles().agentsFiles.length !== 0
  ) {
    throw new Error(`Pi controlled ResourceLoader discovered an unexpected resource: ${JSON.stringify({
      extensions: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
      skills: resourceLoader.getSkills().skills.map((skill) => skill.name),
      prompts: resourceLoader.getPrompts().prompts.length,
      themes: resourceLoader.getThemes().themes.length,
      agentsFiles: resourceLoader.getAgentsFiles().agentsFiles.length
    })}`)
  }
  const loadedSkillNames = resourceLoader.getSkills().skills.map((skill) => skill.name).sort()
  if (JSON.stringify(loadedSkillNames) !== JSON.stringify([...skillNames].sort())) {
    throw new Error(`Pi controlled ResourceLoader 缺少冻结 Skill：${[...skillNames].join(', ')}`)
  }
  if (
    resourceLoader.getSystemPrompt() !== input.systemPrompt.text ||
    resourceLoader.getAppendSystemPrompt().length !== 0
  ) {
    throw new Error('Pi effective system prompt differs from the frozen Javdex prompt')
  }
  return { settingsManager, resourceLoader }
}

function toolDefinitions(
  input: RuntimeSessionInit,
  queue: DurableObservationQueue,
  observer: RuntimeObserver,
  committedToolCalls: Set<string>
): ToolDefinition[] {
  return input.tools.map((binding) => ({
    name: binding.name,
    label: binding.label,
    description: binding.description,
    parameters: binding.schema as never,
    executionMode: binding.executionMode,
    async execute(toolCallId, params, signal, onUpdate) {
      const args = params && typeof params === 'object' ? params as Record<string, unknown> : {}
      const toolSignal = signal ?? new AbortController().signal
      try {
        const result = await binding.invoke({
          runId: input.runId,
          callId: toolCallId,
          args,
          signal: toolSignal,
          progress(summary) {
            observer.notify({ type: 'tool.progress', callId: toolCallId, summary })
            onUpdate?.({ content: [{ type: 'text', text: summary }], details: { summary } })
          }
        })
        const frame = recovery('tool-result', { toolCallId, toolName: binding.name, result })
        await queue.enqueue({
          type: 'tool.completed',
          result: { callId: toolCallId, toolName: binding.name, ok: result.ok, summary: result.summary },
          recovery: frame
        })
        committedToolCalls.add(toolCallId)
        // A terminating control result (for example waiting_user or a loop breaker) must reach Pi
        // even when the domain operation itself did not pass. Throwing first would discard
        // `terminate` and let the model continue the very loop the tool asked it to stop.
        if (!result.ok && !result.terminate) throw new Error(result.content)
        return {
          content: [{ type: 'text' as const, text: result.content }],
          details: { summary: result.summary, detail: result.detail },
          terminate: result.terminate
        }
      } catch (error) {
        if (!committedToolCalls.has(toolCallId)) {
          const message = error instanceof Error ? error.message : String(error)
          const frame = recovery('tool-result', { toolCallId, toolName: binding.name, error: message })
          await queue.enqueue({
            type: 'tool.completed',
            result: { callId: toolCallId, toolName: binding.name, ok: false, summary: truncateUnicode(message, 240) },
            recovery: frame
          })
          committedToolCalls.add(toolCallId)
        }
        throw error
      }
    }
  }))
}

class PiRuntimeSession implements RuntimeSessionPort {
  readonly ref: OpaqueRuntimeSessionRef
  private readonly acceptedCommandIds = new Set<AgentOperationId>()
  private readonly unsubscribe: () => void
  private compactionDepth = 0
  private pendingProviderError?: string
  private operationTurnCount = 0
  private aborting = false
  private disposed = false
  private readonly effectiveSystemPrompt: string
  constructor(
    private readonly input: RuntimeSessionInit,
    private readonly observer: RuntimeObserver,
    private readonly queue: DurableObservationQueue,
    private readonly session: AgentSession,
    private readonly committedToolCalls: Set<string>
  ) {
    this.effectiveSystemPrompt = input.resources
      ? session.systemPrompt
      : input.systemPrompt.text
    this.ref = makeRef(session)
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event))
    this.installSystemPromptGuard()
    this.installTurnBudget()
    this.installCacheBridge()
    this.queue.setAbortRuntime(async () => {
      if (!this.disposed) await this.session.abort()
    })
  }

  private installSystemPromptGuard(): void {
    const prepare = this.session.agent.prepareNextTurnWithContext
    if (!prepare) throw new Error('Pi Agent 缺少 prepareNextTurnWithContext prompt guard seam')
    if (!this.effectiveSystemPrompt.includes(this.input.systemPrompt.text)) {
      throw new Error('Pi effective system prompt 丢失冻结的 Javdex prompt')
    }
    this.session.agent.state.systemPrompt = this.effectiveSystemPrompt
    this.session.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const prepared = await prepare(turn, signal)
      this.session.agent.state.systemPrompt = this.effectiveSystemPrompt
      return {
        ...prepared,
        context: {
          ...(prepared?.context ?? turn.context),
          systemPrompt: this.effectiveSystemPrompt,
          tools: this.session.agent.state.tools.slice()
        },
        model: this.session.agent.state.model,
        thinkingLevel: this.session.agent.state.thinkingLevel
      }
    }
  }

  private installCacheBridge(): void {
    const original = this.session.agent.streamFunction
    this.session.agent.streamFunction = async (model, context, options) => {
      await this.queue.drain()
      // Pi rebuilds its base prompt before a fresh prompt and adds cwd metadata. The
      // Javdex adapter owns the final provider context, so normalize it at the last
      // public seam before streaming as well as between continuation turns.
      context.systemPrompt = this.effectiveSystemPrompt
      this.session.agent.state.systemPrompt = this.effectiveSystemPrompt
      const summarizing = this.compactionDepth > 0
      return original(model, context, {
        ...options,
        fetch: this.input.model.fetch,
        timeoutMs: this.input.model.preset.timeoutMs,
        maxTokens: this.input.model.preset.maxTokens,
        cacheRetention: summarizing
          ? this.input.cache.retention.summarizer
          : this.input.cache.retention.primary,
        sessionId: summarizing
          ? this.input.cache.summarizerAffinityId
          : this.input.cache.primaryAffinityId
      })
    }
  }

  private installTurnBudget(): void {
    const maxTurns = Math.max(0, Math.round(this.input.settings.maxTurns ?? 0))
    if (maxTurns === 0) return
    const previous = this.session.agent.shouldStopAfterTurn
    this.session.agent.shouldStopAfterTurn = async (turn, signal) => {
      if (previous && await previous(turn, signal)) return true
      this.operationTurnCount += 1
      if (this.operationTurnCount < maxTurns) return false
      this.enqueue({
        type: 'limit.reached',
        resource: 'model-turns',
        current: this.operationTurnCount,
        limit: maxTurns
      })
      return true
    }
  }

  private enqueue(event: RuntimeDurableObservation): void {
    void this.queue.enqueue(event).catch(() => undefined)
  }

  private enqueueAgentSettled(): void {
    const acceptedCommandIds = [...this.acceptedCommandIds]
    const barrier = this.queue.enqueue({ type: 'agent.settled', acceptedCommandIds })
    void barrier.then(() => {
      for (const id of acceptedCommandIds) this.acceptedCommandIds.delete(id)
    }).catch(() => undefined)
  }

  private handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'message_update': {
        const streamEvent = event.assistantMessageEvent
        if (streamEvent.type === 'text_delta') {
          this.observer.notify({ type: 'assistant.delta', text: streamEvent.delta })
        } else if (streamEvent.type === 'thinking_delta') {
          this.observer.notify({ type: 'reasoning.delta', text: streamEvent.delta })
        }
        break
      }
      case 'message_end': {
        const audit = messageAudit(event.message)
        const frame = recovery('message', event.message)
        this.enqueue({ type: 'message.completed', audit, recovery: frame })
        const usage = usageFromMessage(event.message)
        const normalized = usage ? normalizedUsage(this.input, 'primary', usage) : undefined
        if (usage) {
          this.enqueue({ type: 'usage', usage: normalized! })
        }
        const message = event.message as { role?: string; stopReason?: string; errorMessage?: string }
        if (message.role === 'assistant') {
          // Pi emits message_end before it decides whether a provider error is retryable.
          // Keep the attempt error local until agent_settled; a successful auto-retry clears it.
          // `runtime.fault` is terminal downstream, so emitting it here would poison ToolHost
          // while Pi is still retrying the same operation.
          this.pendingProviderError = message.stopReason === 'error'
            ? message.errorMessage || '模型供应商返回错误'
            : undefined
        }
        break
      }
      case 'tool_execution_start':
        this.enqueue({
          type: 'tool.started',
          call: {
            callId: event.toolCallId,
            toolName: event.toolName,
            argsDigest: sha256(JSON.stringify(event.args))
          }
        })
        break
      case 'tool_execution_update': {
        const partial = event.partialResult as { details?: { summary?: unknown } }
        const summary = typeof partial?.details?.summary === 'string' ? partial.details.summary : '工具执行中'
        this.observer.notify({ type: 'tool.progress', callId: event.toolCallId, summary })
        break
      }
      case 'tool_execution_end':
        if (!this.committedToolCalls.has(event.toolCallId)) {
          const frame = recovery('tool-result', event.result)
          this.enqueue({
            type: 'tool.completed',
            result: {
              callId: event.toolCallId,
              toolName: event.toolName,
              ok: !event.isError,
              summary: truncateUnicode(textFromContent((event.result as { content?: unknown })?.content), 240)
            },
            recovery: frame
          })
          this.committedToolCalls.add(event.toolCallId)
        }
        break
      case 'queue_update':
        this.enqueue({ type: 'queue.changed', steering: event.steering.length, followUp: event.followUp.length })
        break
      case 'auto_retry_start':
        this.enqueue({ type: 'retry.changed', phase: 'start', attempt: event.attempt })
        break
      case 'auto_retry_end':
        if (event.success) {
          this.pendingProviderError = undefined
        } else if (!this.aborting) {
          this.pendingProviderError = event.finalError || this.pendingProviderError || '模型供应商重试失败'
        }
        this.enqueue({ type: 'retry.changed', phase: 'end', attempt: event.attempt })
        break
      case 'compaction_start':
        this.compactionDepth += 1
        this.enqueue({ type: 'compaction.changed', phase: 'start' })
        break
      case 'compaction_end': {
        this.compactionDepth = Math.max(0, this.compactionDepth - 1)
        const result = event.result as undefined | {
          summary?: string
          firstKeptEntryId?: string
          tokensBefore?: number
          estimatedTokensAfter?: number
          usage?: Record<string, unknown>
        }
        this.enqueue({
          type: 'compaction.changed',
          phase: 'end',
          result: {
            reason: event.reason,
            tokensBefore: result?.tokensBefore,
            tokensAfter: result?.estimatedTokensAfter,
            firstKeptEntryId: result?.firstKeptEntryId,
            summaryHash: result?.summary ? sha256(result.summary) : undefined
          }
        })
        if (result?.usage) {
          this.enqueue({ type: 'usage', usage: normalizedUsage(this.input, 'summarizer', result.usage) })
        }
        break
      }
      case 'entry_appended':
        this.enqueue({ type: 'session.saved', ref: makeRef(this.session) })
        break
      case 'agent_settled': {
        const providerError = this.pendingProviderError
        this.pendingProviderError = undefined
        if (providerError && !this.aborting) {
          this.enqueue({
            type: 'runtime.fault',
            category: 'provider-failed',
            message: providerError
          })
        }
        this.enqueueAgentSettled()
        break
      }
      default:
        break
    }
  }

  async dispatch(command: {
    commandId: AgentOperationId
    kind: 'prompt' | 'steer' | 'follow-up'
    content: { text: string }
  }): Promise<{ accepted: boolean }> {
    if (this.disposed) return { accepted: false }
    const text = command.content.text.trim()
    if (!text) return { accepted: false }
    if (command.kind === 'steer') {
      await this.session.steer(text)
      this.acceptedCommandIds.add(command.commandId)
      return { accepted: true }
    }
    if (command.kind === 'follow-up' && this.session.isStreaming) {
      await this.session.followUp(text)
      this.acceptedCommandIds.add(command.commandId)
      return { accepted: true }
    }
    if (this.session.isStreaming) return { accepted: false }
    this.operationTurnCount = 0
    this.pendingProviderError = undefined
    return new Promise((resolve) => {
      let resolved = false
      const finish = (accepted: boolean): void => {
        if (resolved) return
        resolved = true
        if (accepted) this.acceptedCommandIds.add(command.commandId)
        resolve({ accepted })
      }
      void this.session.prompt(text, {
        expandPromptTemplates: false,
        source: 'rpc',
        preflightResult: finish
      }).catch((error) => {
        finish(false)
        this.enqueue({
          type: 'runtime.fault',
          category: 'runtime-failed',
          message: error instanceof Error ? error.message : String(error)
        })
      })
    })
  }

  async requestManualCompaction(
    commandId: AgentOperationId,
    instructions?: string
  ): Promise<{ accepted: boolean }> {
    if (this.disposed || this.session.isStreaming || this.session.isCompacting) return { accepted: false }
    this.acceptedCommandIds.add(commandId)
    void this.session.compact(instructions)
      .then(async () => {
        await this.queue.enqueue({ type: 'agent.settled', acceptedCommandIds: [commandId] })
        this.acceptedCommandIds.delete(commandId)
      })
      .catch((error) => {
        this.enqueue({
          type: 'runtime.fault',
          category: 'runtime-failed',
          message: error instanceof Error ? error.message : String(error)
        })
      })
    return { accepted: true }
  }

  async abort(): Promise<void> {
    this.aborting = true
    this.pendingProviderError = undefined
    try {
      this.session.clearQueue()
      this.session.abortRetry()
      this.session.abortCompaction()
      this.session.abortBranchSummary()
      await this.session.abort()
      await this.queue.drain()
    } finally {
      this.pendingProviderError = undefined
      this.aborting = false
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    await this.abort().catch(() => undefined)
    this.session.dispose()
    await this.queue.drain()
  }
}

async function openSession(
  input: RuntimeSessionInit,
  observer: RuntimeObserver,
  source: 'created' | 'restored',
  rebuildHistory?: readonly ExecutionHistoryFrame[]
): Promise<PiRuntimeSession> {
  const { SessionManager, createAgentSession } = await loadPi()
  fs.mkdirSync(input.sessionDirectory, { recursive: true })
  const { modelRuntime, model } = await createControlledModelRuntime(input)
  const { settingsManager, resourceLoader } = await createControlledResources(input)
  let sessionManager: PiSessionManager
  if (source === 'restored') {
    assertResumeRef(input.resume!, input.sessionDirectory)
    try {
      sessionManager = SessionManager.open(input.resume!.sessionFile, input.sessionDirectory, input.sessionDirectory)
    } catch (error) {
      throw new Error(`checkpoint-corrupt: ${(error as Error).message}`)
    }
    if (sessionManager.getSessionId() !== input.resume!.sessionId) {
      throw new Error('checkpoint-corrupt: session id mismatch')
    }
  } else {
    sessionManager = SessionManager.create(input.sessionDirectory, input.sessionDirectory)
    if (rebuildHistory) {
      for (const frame of rebuildHistory) {
        if (frame.runtimeId !== 'pi' || frame.codecVersion !== RECOVERY_CODEC_VERSION) {
          throw new Error(`checkpoint-incompatible: unsupported history codec at ${frame.seq}`)
        }
        if (sha256(frame.recovery.payload) !== frame.contentHash) {
          throw new Error(`checkpoint-corrupt: invalid history frame ${frame.seq}`)
        }
        const decoded = JSON.parse(frame.recovery.payload) as { kind?: string; value?: unknown }
        if (decoded.kind === 'message') sessionManager.appendMessage(decoded.value as never)
      }
    }
  }
  const queue = new DurableObservationQueue(observer)
  const committedToolCalls = new Set<string>()
  const customTools = toolDefinitions(input, queue, observer, committedToolCalls)
  const nativeTools = input.resources?.nativeTools ?? []
  const enabledTools = [...nativeTools, ...input.tools.map((tool) => tool.name)]
  const { session } = await createAgentSession({
    cwd: input.sessionDirectory,
    agentDir: path.join(input.sessionDirectory, 'controlled-agent-dir'),
    modelRuntime,
    model,
    thinkingLevel: input.model.preset.thinkingLevel,
    noTools: enabledTools.length === 0 ? 'all' : undefined,
    tools: enabledTools,
    excludeTools: [],
    customTools,
    resourceLoader,
    sessionManager,
    settingsManager
  })
  const runtime = new PiRuntimeSession(input, observer, queue, session, committedToolCalls)
  await queue.enqueue({ type: 'session.saved', ref: runtime.ref })
  return runtime
}

class PiRuntimePort implements AgentRuntimePort {
  readonly runtimeId = 'pi' as const

  async open(input: RuntimeSessionInit, observer: RuntimeObserver) {
    const source = input.resume ? 'restored' as const : 'created' as const
    return { source, session: await openSession(input, observer, source) }
  }

  async rebuild(
    input: RuntimeSessionInitWithoutResume,
    history: readonly ExecutionHistoryFrame[],
    observer: RuntimeObserver
  ): Promise<RuntimeSessionPort> {
    return openSession(input, observer, 'created', history)
  }
}

export function createPiRuntimePort(): AgentRuntimePort {
  return new PiRuntimePort()
}
