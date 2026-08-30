import type {
  PluginDevAgentEvent,
  PluginDevAgentMessageInput,
  PluginDevPendingApproval,
  PluginDevSessionStatus
} from '@shared/pluginDevTypes'
import type { ScraperPluginDescriptor, ScraperPluginPackage } from '@shared/scraperPluginTypes'
import type { PluginDevConversationItem } from './types'

type PluginDevConversationStreamEvent = Extract<
  PluginDevAgentEvent,
  {
    type:
      | 'assistant_text_delta'
      | 'assistant_reasoning_delta'
      | 'assistant_text'
      | 'assistant_reasoning'
  }
>

function replaceConversationItem(
  items: PluginDevConversationItem[],
  next: PluginDevConversationItem
): PluginDevConversationItem[] {
  const index = items.findIndex((item) => item.id === next.id)
  if (index < 0) return [...items.slice(-120), next]
  return items.map((item, itemIndex) => itemIndex === index ? next : item)
}

/** Merge ephemeral deltas and the durable completion into one stable item per model turn. */
export function projectPluginDevConversationStream(
  items: PluginDevConversationItem[],
  event: PluginDevConversationStreamEvent
): PluginDevConversationItem[] {
  if (event.type === 'assistant_reasoning_delta') {
    const id = `reasoning:${event.sessionId}:${event.turn}`
    const current = items.find(
      (item): item is Extract<PluginDevConversationItem, { type: 'reasoning' }> =>
        item.id === id && item.type === 'reasoning'
    )
    const text = `${current?.text ?? ''}${event.delta}`
    return replaceConversationItem(items, {
      id,
      type: 'reasoning',
      step: event.step,
      turn: event.turn,
      text,
      charCount: Array.from(text).length,
      truncated: false,
      streaming: true
    })
  }

  if (event.type === 'assistant_text_delta') {
    const id = `assistant:${event.sessionId}:${event.turn}`
    const current = items.find(
      (item): item is Extract<PluginDevConversationItem, { type: 'agent' }> =>
        item.id === id && item.type === 'agent'
    )
    return replaceConversationItem(items, {
      id,
      type: 'agent',
      turn: event.turn,
      text: `${current?.text ?? ''}${event.delta}`,
      streaming: true
    })
  }

  if (event.type === 'assistant_reasoning') {
    return replaceConversationItem(items, {
      id: `reasoning:${event.sessionId}:${event.turn}`,
      type: 'reasoning',
      step: event.step,
      turn: event.turn,
      text: event.text,
      charCount: event.charCount,
      truncated: event.truncated,
      streaming: false
    })
  }

  if (event.turn === undefined) return items
  return replaceConversationItem(items, {
    id: `assistant:${event.sessionId}:${event.turn}`,
    type: 'agent',
    turn: event.turn,
    text: event.text,
    streaming: false
  })
}

export interface PluginDevLocalAgentOperation {
  id: number
  kind: 'start' | 'message'
  /** A start operation is unbound until its first event reveals the new session id. */
  sessionId: string | null
}

export interface PluginDevAgentEventResolution {
  accepted: boolean
  sessionId: string | null
  operation: PluginDevLocalAgentOperation | null
}

/**
 * Resolve a broadcast Agent event against the exact session owned by this panel.
 * Message continuations are always session-bound; only a new start (or the brief
 * initial snapshot bootstrap window) may claim an unbound session.
 */
export function resolvePluginDevAgentEvent(options: {
  eventSessionId: string
  activeSessionId: string | null
  operation: PluginDevLocalAgentOperation | null
  allowSnapshotBootstrap: boolean
}): PluginDevAgentEventResolution {
  const { eventSessionId, activeSessionId, operation, allowSnapshotBootstrap } = options

  if (operation?.sessionId) {
    return {
      accepted: operation.sessionId === eventSessionId,
      sessionId: operation.sessionId,
      operation
    }
  }

  if (operation?.kind === 'start') {
    return {
      accepted: true,
      sessionId: eventSessionId,
      operation: { ...operation, sessionId: eventSessionId }
    }
  }

  if (activeSessionId) {
    return {
      accepted: activeSessionId === eventSessionId,
      sessionId: activeSessionId,
      operation
    }
  }

  if (allowSnapshotBootstrap) {
    return { accepted: true, sessionId: eventSessionId, operation }
  }

  return { accepted: false, sessionId: null, operation }
}

export function isAgentDispatchSettlingEvent(event: PluginDevAgentEvent): boolean {
  return event.type === 'waiting_user' || event.type === 'done' || event.type === 'error'
}

/** Live workspace drafts arrive via `package_updated`. Terminal `done` must not clobber the editor. */
export function packageFromPluginDevAgentEvent(
  event: PluginDevAgentEvent
): ScraperPluginPackage | null {
  return event.type === 'package_updated' ? event.package : null
}

export function shouldReleaseAgentBusyForEvent(
  event: PluginDevAgentEvent,
  operation: PluginDevLocalAgentOperation | null
): boolean {
  return isAgentDispatchSettlingEvent(event) && operation === null
}

export interface PluginDevMessageDispatchCheck {
  allowed: boolean
  approval: PluginDevPendingApproval | null
  reason?: 'approval-required' | 'approval-mismatch' | 'unexpected-approval'
}

/** Enforce one-use, exact-request approval decisions before dispatching chat. */
export function checkPluginDevMessageDispatch(
  pendingApproval: PluginDevPendingApproval | null,
  decision?: PluginDevAgentMessageInput['approvalDecision']
): PluginDevMessageDispatchCheck {
  if (pendingApproval) {
    if (!decision) {
      return { allowed: false, approval: null, reason: 'approval-required' }
    }
    if (decision.requestId !== pendingApproval.requestId) {
      return { allowed: false, approval: null, reason: 'approval-mismatch' }
    }
    return { allowed: true, approval: pendingApproval }
  }

  if (decision) {
    return { allowed: false, approval: null, reason: 'unexpected-approval' }
  }
  return { allowed: true, approval: null }
}

export interface PluginDevSnapshotGate {
  begin(): number
  observeMutation(): void
  canApply(version: number): boolean
}

/** Prevent an async snapshot from overwriting live state observed after the request began. */
export function createPluginDevSnapshotGate(): PluginDevSnapshotGate {
  let version = 0
  return {
    begin(): number {
      return version
    },
    observeMutation(): void {
      version += 1
    },
    canApply(candidate: number): boolean {
      return candidate === version
    }
  }
}

export function canClearPluginDevAgentHistory(options: {
  hasHistory: boolean
  status: PluginDevSessionStatus | null
  busy: boolean
}): boolean {
  return options.hasHistory && options.status !== 'running' && !options.busy
}

export function canInstallPluginDevDraft(options: {
  hasUninstalledChanges: boolean
  hasAgentSession: boolean
  checkReady: boolean
  resultStale: boolean
}): boolean {
  if (!options.hasUninstalledChanges || options.resultStale) return false
  if (!options.hasAgentSession) return true
  return options.checkReady
}

export function requiresPluginDevContinuationFeedback(options: {
  canResumeAgent: boolean
  artifactReady: boolean
  feedbackText: string
}): boolean {
  return options.canResumeAgent && options.artifactReady && options.feedbackText.trim().length === 0
}

export function pluginDevAgentEndNotice(
  status: PluginDevSessionStatus,
  artifactReady: boolean
): { message: string; kind: 'success' | 'error' | 'info' } {
  if (status === 'waiting_user') {
    return artifactReady
      ? { message: '机械验收通过，可以安装', kind: 'success' }
      : { message: 'Agent 本轮已结束，可继续完善', kind: 'info' }
  }
  if (status === 'completed') return { message: '插件已安装', kind: 'success' }
  if (status === 'cancelled') return { message: 'Agent 已终止', kind: 'info' }
  if (status === 'failed') return { message: 'Agent 运行失败', kind: 'error' }
  return { message: 'Agent 状态已更新', kind: 'info' }
}

/** Sessions the current workbench can restore after leaving the page. */
export function isRecoverablePluginDevSessionStatus(status: PluginDevSessionStatus): boolean {
  return status === 'running' || status === 'waiting_user'
}

/** Terminal history is discoverable but must never overwrite the current editor on entry. */
export function shouldApplyInitialPluginDevSnapshot(status: PluginDevSessionStatus): boolean {
  return isRecoverablePluginDevSessionStatus(status)
}

export interface PluginDevSelectablePlugin {
  name: string
  source: 'user' | 'builtin'
}

export interface PluginDevLoadedPluginIdentity {
  selectedPluginName: string
  loadedInstalledName: string | null
  forkedFromBuiltIn: string | null
}

export function pluginDevLoadedPluginIdentity(
  name: string,
  source: PluginDevSelectablePlugin['source']
): PluginDevLoadedPluginIdentity {
  return source === 'builtin'
    ? {
        selectedPluginName: name,
        loadedInstalledName: null,
        forkedFromBuiltIn: name
      }
    : {
        selectedPluginName: name,
        loadedInstalledName: name,
        forkedFromBuiltIn: null
      }
}

export function listPluginDevSelectablePlugins(
  plugins: readonly ScraperPluginDescriptor[]
): PluginDevSelectablePlugin[] {
  return plugins
    .filter(
      (plugin): plugin is ScraperPluginDescriptor & { source: 'user' | 'builtin' } =>
        (plugin.source === 'user' || plugin.source === 'builtin') &&
        plugin.debuggable !== false
    )
    .map((plugin) => ({ name: plugin.name, source: plugin.source }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

export function shouldIgnorePluginDevSelection(options: {
  nextName: string
  selectedName: string
  hasLoadedPlugin: boolean
}): boolean {
  if (options.nextName !== options.selectedName) return false
  return options.nextName !== '' || !options.hasLoadedPlugin
}
