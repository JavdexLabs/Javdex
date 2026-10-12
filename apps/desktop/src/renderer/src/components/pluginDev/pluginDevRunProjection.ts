import type {
  PluginDevAgentContextStats, PluginDevAgentEvent, PluginDevAgentPhase, PluginDevAgentSnapshot,
  PluginDevFrozenModelSummary, PluginDevPendingApproval, PluginDevPendingUserRequest,
  PluginDevSessionStatus, PluginExecutionArtifact, PluginRunAcceptanceOutcome
} from '@shared/pluginDevTypes'
import { fingerprintPluginRuntime } from './pluginDevPackageSnapshot'
import { projectPluginDevConversationStream } from './pluginDevAgentUiState'
import type { PluginDevConversationItem } from './types'

export interface PluginDevRunProjection {
  agentSessionId: string | null
  agentStatus: PluginDevSessionStatus | null
  agentPhase: PluginDevAgentPhase
  agentStep: number
  contextStats: PluginDevAgentContextStats | null
  activeTool: string | null
  conversationItems: PluginDevConversationItem[]
  waitingUserReason: string | null
  pendingApproval: PluginDevPendingApproval | null
  pendingUserRequest: PluginDevPendingUserRequest | null
  frozenModel: PluginDevFrozenModelSummary | null
  execution: PluginExecutionArtifact | null
  acceptance: PluginRunAcceptanceOutcome | null
  executionPackageFingerprint: string | null
  hasAgentHistory: boolean
}

let sequence = 0
export function nextConversationId(prefix: string): string { return `${prefix}:${++sequence}` }

export function emptyPluginDevRun(): PluginDevRunProjection {
  return { agentSessionId: null, agentStatus: null, agentPhase: 'idle', agentStep: 0, contextStats: null,
    activeTool: null, conversationItems: [], waitingUserReason: null, pendingApproval: null,
    pendingUserRequest: null, frozenModel: null, execution: null, acceptance: null,
    executionPackageFingerprint: null, hasAgentHistory: false }
}

type Action = { type: 'patch'; patch: Partial<PluginDevRunProjection> | ((state: PluginDevRunProjection) => Partial<PluginDevRunProjection>) }
  | { type: 'event'; event: PluginDevAgentEvent; runtimeFingerprint: string | null }
  | { type: 'snapshot'; snapshot: PluginDevAgentSnapshot; conversation: PluginDevConversationItem[] }
  | { type: 'reset' }

/** Host facts projected into UI state; no I/O, commands, draft editing or runtime ownership. */
export function pluginDevRunReducer(state: PluginDevRunProjection, action: Action): PluginDevRunProjection {
  if (action.type === 'patch') return { ...state, ...(typeof action.patch === 'function' ? action.patch(state) : action.patch) }
  if (action.type === 'reset') return { ...emptyPluginDevRun(), hasAgentHistory: state.hasAgentHistory }
  if (action.type === 'snapshot') {
    const { snapshot, conversation } = action
    const { result } = snapshot
    const waiting = [...snapshot.events].reverse().find(event => event.type === 'waiting_user')
    const context = [...snapshot.events].reverse().find(event => event.type === 'context_updated')
    return { ...emptyPluginDevRun(), agentSessionId: result.sessionId, agentStatus: result.status,
      agentPhase: snapshot.phase, agentStep: snapshot.step, frozenModel: result.frozenModel ?? null,
      execution: result.execution ?? null, acceptance: result.acceptance ?? null,
      executionPackageFingerprint: result.execution ? fingerprintPluginRuntime(result.package) : null,
      conversationItems: conversation, pendingApproval: snapshot.pendingApprovals?.[0] ?? null,
      pendingUserRequest: snapshot.pendingUserRequest ?? null,
      waitingUserReason: result.status === 'waiting_user' ? waiting?.reason ?? result.summary : null,
      contextStats: context?.stats ?? null, hasAgentHistory: true }
  }
  const { event } = action
  const append = (item: PluginDevConversationItem) => [...state.conversationItems, item].slice(-120)
  switch (event.type) {
    case 'step_start': return { ...state, agentStatus: 'running', agentStep: event.step, activeTool: null }
    case 'phase_updated': return { ...state, agentPhase: event.phase, agentStep: event.step }
    case 'context_updated': return { ...state, agentStep: event.step, contextStats: event.stats }
    case 'tool_start': return { ...state, agentStep: event.step, activeTool: event.tool }
    case 'assistant_text_delta': case 'assistant_reasoning_delta': case 'assistant_reasoning':
      return { ...state, conversationItems: projectPluginDevConversationStream(state.conversationItems, event) }
    case 'assistant_text': return { ...state, conversationItems: event.turn !== undefined
      ? projectPluginDevConversationStream(state.conversationItems, event)
      : append({ id: nextConversationId('agent'), type: 'agent', text: event.text }) }
    case 'tool_result': return { ...state, agentStep: event.step, activeTool: null, conversationItems: append({
      id: nextConversationId(`tool:${event.step}:${event.tool}`), type: 'tool', step: event.step,
      tool: event.tool, summary: event.summary, detail: event.detail, ok: event.ok }) }
    case 'workspace_status': return { ...state, conversationItems: append({ id: nextConversationId(`workspace:${event.step}`),
      type: 'tool', step: event.step, tool: 'workspace_validate', summary: event.message, ok: event.valid }) }
    case 'package_updated': return state.executionPackageFingerprint && state.executionPackageFingerprint !== fingerprintPluginRuntime(event.package)
      ? { ...state, execution: null, acceptance: null, executionPackageFingerprint: null } : state
    case 'execution_updated': return { ...state, execution: event.execution, executionPackageFingerprint: action.runtimeFingerprint }
    case 'acceptance_updated': return { ...state, acceptance: event.outcome }
    case 'user_input_required': return { ...state, agentStatus: 'waiting_user', pendingUserRequest: event.request, waitingUserReason: event.request.prompt }
    case 'approval_required': return { ...state, pendingApproval: { requestId: event.requestId, tool: event.tool, args: event.args, reason: event.reason } }
    case 'waiting_user': return { ...state, agentStatus: 'waiting_user', waitingUserReason: event.reason }
    case 'done': return { ...state, agentStatus: event.success ? 'completed' : 'failed', pendingApproval: null,
      pendingUserRequest: null, waitingUserReason: null, activeTool: null,
      execution: event.execution ?? state.execution, acceptance: event.acceptance ?? state.acceptance,
      executionPackageFingerprint: event.execution ? fingerprintPluginRuntime(event.package) : state.executionPackageFingerprint }
    case 'error': return { ...state, agentStatus: 'failed', activeTool: null, pendingApproval: null,
      waitingUserReason: null, conversationItems: append({ id: nextConversationId('agent:error'), type: 'agent', text: event.message }) }
    default: return state
  }
}
