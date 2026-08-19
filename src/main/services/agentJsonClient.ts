import { AsyncLocalStorage } from 'node:async_hooks'
import type { SimpleChatMessage } from './llm/adapters/openaiChatAdapter'
import { modelInvocation } from '../agent-platform/modelInvocation'

export type { SimpleChatMessage as AgentJsonChatMessage }

const invocationContext = new AsyncLocalStorage<{ affinityId?: string }>()

export function withAgentJsonInvocationContext<T>(
  context: { affinityId?: string },
  invoke: () => Promise<T>
): Promise<T> {
  return invocationContext.run(context, invoke)
}

export async function requestAgentJson<T>(messages: SimpleChatMessage[]): Promise<T> {
  return (await requestAgentJsonWithRaw<T>(messages)).json
}

export async function requestAgentJsonWithRaw<T>(
  messages: SimpleChatMessage[]
): Promise<{ json: T; rawText: string }> {
  return modelInvocation.requestJson<T>({
    profileId: 'profile:plugin-developer:default',
    role: 'verifier',
    messages,
    affinityId: invocationContext.getStore()?.affinityId
  })
}
