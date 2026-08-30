import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { AgentProfile, AgentToolEffect } from '@shared/aiConfigurationTypes'
import type { AgentOperationId, AgentRunId, HostedToolBinding, HostedToolResult } from './types'
import { AgentRunStore, agentRunStore } from './agentRunStore'

export interface ToolDeclaration {
  name: string
  label: string
  description: string
  schema: Record<string, unknown>
  capability: string
  effect: AgentToolEffect
  executionMode: 'sequential' | 'parallel'
  timeoutMs: number
  resourceKey(args: Record<string, unknown>): string | undefined
  redact(args: Record<string, unknown>): Record<string, unknown>
}

export interface ToolPack {
  ref: string
  tools: readonly ToolDeclaration[]
}

export interface ToolHandlerContext {
  runId: AgentRunId
  operationId?: AgentOperationId
  callId: string
  args: Record<string, unknown>
  signal: AbortSignal
  progress(summary: string): void
}

export type ToolHandler = (context: ToolHandlerContext) => Promise<HostedToolResult>

interface RegisteredRun {
  status: () => string
  handlers: ReadonlyMap<string, ToolHandler>
  profile: AgentProfile
  operationId: () => AgentOperationId | undefined
  permits: Map<string, { requestId: string; permit: string }>
  onApprovalRequired?: (request: {
    requestId: string
    toolName: string
    args: Record<string, unknown>
    effect: AgentToolEffect
  }) => void
  /** Extra mutable domain state that must be covered by an approval permit. */
  approvalScope?: (
    toolName: string,
    args: Record<string, unknown>
  ) => Record<string, unknown> | undefined
  /** Product flows that render one approval card can supersede older pending requests. */
  singlePendingApproval?: boolean
}

export class ApprovalRequiredError extends Error {
  constructor(readonly requestId: string, readonly toolName: string) {
    super(`工具 ${toolName} 需要用户批准（${requestId}）`)
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function resultAudit(result: HostedToolResult): Record<string, unknown> {
  return {
    ok: result.ok,
    summaryHash: digest(result.summary),
    summaryChars: [...result.summary].length,
    terminate: result.terminate === true
  }
}

function errorAudit(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  return {
    errorName: error instanceof Error ? error.name : 'Error',
    messageHash: digest(message),
    messageChars: [...message].length
  }
}

function schemaHash(declaration: ToolDeclaration): string {
  return digest({
    name: declaration.name,
    description: declaration.description,
    schema: declaration.schema,
    executionMode: declaration.executionMode
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('工具执行已取消')
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortError(signal))
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

class ResourceLocks {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string | undefined, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    if (!key) {
      if (signal.aborted) throw abortError(signal)
      return raceWithAbort(Promise.resolve().then(fn), signal)
    }
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    let operation: Promise<T> | undefined
    try {
      await raceWithAbort(previous, signal)
      if (signal.aborted) throw abortError(signal)
      operation = fn()
      return await raceWithAbort(operation, signal)
    } finally {
      // Once a resource operation starts, cancellation may return control to the caller but must
      // not let another operation overlap an underlying handler that has not actually stopped.
      if (operation) void operation.then(release, release)
      else release()
    }
  }
}

export class ToolHost {
  private readonly packs = new Map<string, ToolPack>()
  private readonly runs = new Map<AgentRunId, RegisteredRun>()
  private readonly locks = new ResourceLocks()
  private readonly approvalKey = randomBytes(32)

  constructor(private readonly store: AgentRunStore = agentRunStore) {}

  registerToolPack(pack: ToolPack): void {
    if (this.packs.has(pack.ref)) throw new Error(`ToolPack 已注册：${pack.ref}`)
    const names = new Set<string>()
    for (const declaration of pack.tools) {
      if (names.has(declaration.name)) throw new Error(`ToolPack 工具重名：${declaration.name}`)
      names.add(declaration.name)
    }
    this.packs.set(pack.ref, pack)
  }

  registerRun(input: {
    runId: AgentRunId
    profile: AgentProfile
    status: () => string
    operationId: () => AgentOperationId | undefined
    handlers: ReadonlyMap<string, ToolHandler>
    onApprovalRequired?: RegisteredRun['onApprovalRequired']
    approvalScope?: RegisteredRun['approvalScope']
    singlePendingApproval?: boolean
  }): readonly HostedToolBinding[] {
    if (this.runs.has(input.runId)) throw new Error(`ToolHost run 已注册：${input.runId}`)
    const permits = new Map(
      this.store.listApprovedPermits(input.runId).map((approval) => [
        `${approval.toolName}\0${approval.argsDigest}`,
        { requestId: approval.requestId, permit: approval.permit }
      ])
    )
    const run: RegisteredRun = { ...input, permits }
    this.runs.set(input.runId, run)
    const declarations = input.profile.toolPackRefs.flatMap((ref) => {
      const pack = this.packs.get(ref)
      if (!pack) throw new Error(`ToolPack 不存在：${ref}`)
      return pack.tools
    })
    const seen = new Set<string>()
    return declarations.map((declaration) => {
      if (seen.has(declaration.name)) throw new Error(`冻结 ToolPack 中工具重名：${declaration.name}`)
      seen.add(declaration.name)
      const handler = input.handlers.get(declaration.name)
      if (!handler) throw new Error(`工具缺少 handler：${declaration.name}`)
      return {
        name: declaration.name,
        label: declaration.label,
        description: declaration.description,
        schema: structuredClone(declaration.schema),
        schemaHash: schemaHash(declaration),
        capability: declaration.capability,
        effect: declaration.effect,
        executionMode: declaration.executionMode,
        invoke: async ({ callId, args, signal, progress }) => this.invoke(
          input.runId,
          declaration,
          handler,
          callId,
          args,
          signal,
          progress
        )
      }
    })
  }

  private approvalRequestId(runId: string, callId: string, toolName: string, argsDigest: string): string {
    return `apr_${createHmac('sha256', this.approvalKey)
      .update([runId, callId, toolName, argsDigest].join('\0'))
      .digest('base64url')}`
  }

  private async invoke(
    runId: string,
    declaration: ToolDeclaration,
    handler: ToolHandler,
    callId: string,
    args: Record<string, unknown>,
    parentSignal: AbortSignal,
    progress: (summary: string) => void
  ): Promise<HostedToolResult> {
    const run = this.runs.get(runId)
    if (!run) throw new Error('ToolHost run 不存在或已关闭')
    if (!['created', 'running'].includes(run.status())) {
      throw new Error(`run 状态 ${run.status()} 不允许执行工具`)
    }
    const approvalScope = run.approvalScope?.(declaration.name, args)
    const effectiveArgs = approvalScope ? { ...args, ...approvalScope } : args
    const argsDigest = digest(effectiveArgs)
    const created = this.store.beginToolCall({
      callId,
      runId,
      operationId: run.operationId(),
      toolName: declaration.name,
      argsDigest,
      effect: declaration.effect
    })
    if (!created) throw new Error(`工具调用 ${callId} 已存在，拒绝重复副作用`)
    if (!run.profile.capabilityGrants.includes(declaration.capability)) {
      this.store.completeToolCall(callId, 'denied', { reason: 'capability-denied' })
      throw new Error(`Profile 未授权能力：${declaration.capability}`)
    }

    if (run.profile.approvalRequiredEffects.includes(declaration.effect)) {
      const permitKey = `${declaration.name}\0${argsDigest}`
      const requestId = this.approvalRequestId(runId, callId, declaration.name, argsDigest)
      const approved = run.permits.get(permitKey)
      if (!approved || !this.store.consumeApproval(approved.requestId, approved.permit)) {
        if (run.singlePendingApproval) this.store.denyPendingApprovals(runId, requestId)
        this.store.createApproval({ requestId, runId, callId, argsDigest })
        run.onApprovalRequired?.({
          requestId,
          toolName: declaration.name,
          args: declaration.redact(effectiveArgs),
          effect: declaration.effect
        })
        this.store.completeToolCall(callId, 'denied', { reason: 'approval-required', requestId })
        throw new ApprovalRequiredError(requestId, declaration.name)
      }
      run.permits.delete(permitKey)
    }

    const controller = new AbortController()
    const abort = (): void => controller.abort(parentSignal.reason)
    if (parentSignal.aborted) abort()
    else parentSignal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(new Error('工具执行超时')), declaration.timeoutMs)
    try {
      return await this.locks.run(declaration.resourceKey(args), controller.signal, async () => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('工具执行已取消')
        }
        // ResourceLocks owns the abort race. Await the actual handler here so its operation promise
        // remains pending until non-cooperative work really stops; otherwise the resource lock
        // would be released as soon as this inner race rejected while the handler kept running.
        const result = await handler({
          runId,
          operationId: run.operationId(),
          callId,
          args,
          signal: controller.signal,
          progress
        })
        if (controller.signal.aborted) throw abortError(controller.signal)
        this.store.completeToolCall(callId, result.ok ? 'completed' : 'failed', {
          ...resultAudit(result),
          args: declaration.redact(args)
        })
        return result
      })
    } catch (error) {
      const status = controller.signal.aborted
        ? declaration.effect === 'read' ? 'interrupted' : 'uncertain'
        : 'failed'
      this.store.completeToolCall(callId, status, errorAudit(error))
      throw error
    } finally {
      clearTimeout(timeout)
      parentSignal.removeEventListener('abort', abort)
    }
  }

  approve(runId: string, requestId: string): void {
    const run = this.runs.get(runId)
    if (!run) throw new Error('ToolHost run 不存在')
    const pending = this.store.listPendingApprovals(runId).find((item) => item.requestId === requestId)
    if (!pending) throw new Error('审批请求不存在或已处理')
    const permit = randomBytes(32).toString('base64url')
    this.store.decideApproval(requestId, true, permit)
    run.permits.set(`${pending.toolName}\0${pending.argsDigest}`, { requestId, permit })
  }

  deny(runId: string, requestId: string): void {
    if (!this.runs.has(runId)) throw new Error('ToolHost run 不存在')
    this.store.decideApproval(requestId, false, undefined)
  }

  revokeApproval(runId: string, requestId: string): boolean {
    const run = this.runs.get(runId)
    if (run) {
      for (const [key, value] of run.permits) {
        if (value.requestId === requestId) run.permits.delete(key)
      }
    }
    return this.store.revokeApproval(runId, requestId)
  }

  discardApprovals(runId: string): void {
    this.runs.get(runId)?.permits.clear()
    this.store.discardOpenApprovals(runId)
  }

  pendingApprovals(runId: string) {
    return this.store.listPendingApprovals(runId)
  }

  disposeRun(runId: string): void {
    this.runs.delete(runId)
  }
}

export const toolHost = new ToolHost()
