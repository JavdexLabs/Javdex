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

function schemaHash(declaration: ToolDeclaration): string {
  return digest({
    name: declaration.name,
    description: declaration.description,
    schema: declaration.schema,
    executionMode: declaration.executionMode
  })
}

class ResourceLocks {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn()
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release = (): void => undefined
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
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
    const argsDigest = digest(args)
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
        this.store.createApproval({ requestId, runId, callId, argsDigest })
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
      return await this.locks.run(declaration.resourceKey(args), async () => {
        if (controller.signal.aborted) {
          throw controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error('工具执行已取消')
        }
        const result = await handler({
          runId,
          operationId: run.operationId(),
          callId,
          args,
          signal: controller.signal,
          progress
        })
        this.store.completeToolCall(callId, result.ok ? 'completed' : 'failed', {
          ...result,
          args: declaration.redact(args)
        })
        return result
      })
    } catch (error) {
      const status = controller.signal.aborted
        ? declaration.effect === 'read' ? 'interrupted' : 'uncertain'
        : 'failed'
      this.store.completeToolCall(callId, status, { message: (error as Error).message })
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

  pendingApprovals(runId: string) {
    return this.store.listPendingApprovals(runId)
  }

  disposeRun(runId: string): void {
    this.runs.delete(runId)
  }
}

export const toolHost = new ToolHost()
