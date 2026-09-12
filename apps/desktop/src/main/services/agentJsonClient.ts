import { AsyncLocalStorage } from 'node:async_hooks'
import type { SimpleChatMessage } from './llm/adapters/openaiChatAdapter'
import { modelInvocation } from '../agent-platform/modelInvocation'
import type { ResolvedModelAccess } from '../agent-platform/types'
import type { NormalizedModelUsage } from '../agent-platform/types'

export type { SimpleChatMessage as AgentJsonChatMessage }

const invocationContext = new AsyncLocalStorage<{
  affinityId?: string
  access?: ResolvedModelAccess
  signal?: AbortSignal
  onUsage?: (usage: NormalizedModelUsage) => void
}>()

export function withAgentJsonInvocationContext<T>(
  context: {
    affinityId?: string
    access?: ResolvedModelAccess
    signal?: AbortSignal
    onUsage?: (usage: NormalizedModelUsage) => void
  },
  invoke: () => Promise<T>
): Promise<T> {
  return invocationContext.run(context, invoke)
}

export async function requestAgentJson<T>(messages: SimpleChatMessage[]): Promise<T> {
  return (await requestAgentJsonWithRaw<T>(messages)).json
}

export async function requestAgentJsonWithRaw<T>(
  messages: SimpleChatMessage[]
): Promise<{ json: T; rawText: string; usage?: NormalizedModelUsage }> {
  const context = invocationContext.getStore()
  if (!context?.access) {
    throw new Error('JSON 模型调用必须显式使用当前 run 的冻结模型配置')
  }
  const result = await modelInvocation.requestJson<T>({
    role: 'verifier',
    messages,
    affinityId: context?.affinityId,
    access: context.access,
    signal: context?.signal
  })
  if (result.usage) context?.onUsage?.(result.usage)
  return result
}
