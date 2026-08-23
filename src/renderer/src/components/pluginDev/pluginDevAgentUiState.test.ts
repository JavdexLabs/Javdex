import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PluginDevPendingApproval } from '@shared/pluginDevTypes'
import type { ScraperPluginPackage } from '@shared/scraperPluginTypes'
import {
  canClearPluginDevAgentHistory,
  isRecoverablePluginDevSessionStatus,
  canInstallPluginDevDraft,
  checkPluginDevMessageDispatch,
  createPluginDevSnapshotGate,
  listPluginDevSelectablePlugins,
  packageFromPluginDevAgentEvent,
  pluginDevLoadedPluginIdentity,
  pluginDevAgentEndNotice,
  projectPluginDevConversationStream,
  requiresPluginDevContinuationFeedback,
  resolvePluginDevAgentEvent,
  shouldApplyInitialPluginDevSnapshot,
  shouldIgnorePluginDevSelection,
  shouldReleaseAgentBusyForEvent,
  type PluginDevLocalAgentOperation
} from './pluginDevAgentUiState'
import { agentStatusLabel } from './types'

describe('plugin dev Agent UI state', () => {
  it('requires feedback before continuing a mechanically ready Agent', () => {
    assert.equal(requiresPluginDevContinuationFeedback({
      canResumeAgent: true,
      artifactReady: true,
      feedbackText: ''
    }), true)
    assert.equal(requiresPluginDevContinuationFeedback({
      canResumeAgent: true,
      artifactReady: true,
      feedbackText: '继续补充别名'
    }), false)
    assert.equal(requiresPluginDevContinuationFeedback({
      canResumeAgent: true,
      artifactReady: false,
      feedbackText: ''
    }), false)
  })

  it('presents a normal Agent settlement without an error toast', () => {
    assert.deepEqual(pluginDevAgentEndNotice('waiting_user', true), {
      message: '机械验收通过，可以安装',
      kind: 'success'
    })
    assert.deepEqual(pluginDevAgentEndNotice('waiting_user', false), {
      message: 'Agent 本轮已结束，可继续完善',
      kind: 'info'
    })
    assert.deepEqual(pluginDevAgentEndNotice('failed', false), {
      message: 'Agent 运行失败',
      kind: 'error'
    })
    assert.equal(agentStatusLabel('waiting_user', 3, true), '可安装')
  })

  it('coalesces streaming reasoning and answer into their final model-turn items', () => {
    let items = projectPluginDevConversationStream([], {
      type: 'assistant_reasoning_delta',
      sessionId: 'session-a',
      step: 2,
      turn: 3,
      delta: '先检查'
    })
    items = projectPluginDevConversationStream(items, {
      type: 'assistant_reasoning_delta',
      sessionId: 'session-a',
      step: 2,
      turn: 3,
      delta: '页面。'
    })
    items = projectPluginDevConversationStream(items, {
      type: 'assistant_text_delta',
      sessionId: 'session-a',
      step: 2,
      turn: 3,
      delta: '开始实现'
    })

    assert.equal(items.length, 2)
    assert.deepEqual(items[0], {
      id: 'reasoning:session-a:3',
      type: 'reasoning',
      step: 2,
      turn: 3,
      text: '先检查页面。',
      charCount: 6,
      truncated: false,
      streaming: true
    })
    assert.deepEqual(items[1], {
      id: 'assistant:session-a:3',
      type: 'agent',
      turn: 3,
      text: '开始实现',
      streaming: true
    })

    items = projectPluginDevConversationStream(items, {
      type: 'assistant_reasoning',
      sessionId: 'session-a',
      step: 2,
      turn: 3,
      text: '先检查页面。',
      charCount: 6,
      truncated: false
    })
    items = projectPluginDevConversationStream(items, {
      type: 'assistant_text',
      sessionId: 'session-a',
      step: 2,
      turn: 3,
      text: '开始实现。'
    })

    assert.equal(items.length, 2)
    assert.equal(items[0]?.type === 'reasoning' && items[0].streaming, false)
    assert.equal(items[1]?.type === 'agent' && items[1].streaming, false)
    assert.equal(items[1]?.type === 'agent' ? items[1].text : '', '开始实现。')
  })

  it('enables the existing Install button only for a current mechanical acceptance', () => {
    assert.equal(canInstallPluginDevDraft({
      hasUninstalledChanges: true,
      hasAgentSession: true,
      checkReady: true,
      resultStale: false
    }), true)
    assert.equal(canInstallPluginDevDraft({
      hasUninstalledChanges: true,
      hasAgentSession: true,
      checkReady: true,
      resultStale: true
    }), false)
    assert.equal(canInstallPluginDevDraft({
      hasUninstalledChanges: true,
      hasAgentSession: true,
      checkReady: false,
      resultStale: false
    }), false)
  })

  it('allows clearing restored history only when its Agent is not running or busy', () => {
    assert.equal(canClearPluginDevAgentHistory({
      hasHistory: true, status: 'completed', busy: false
    }), true)
    assert.equal(canClearPluginDevAgentHistory({
      hasHistory: true, status: 'running', busy: false
    }), false)
    assert.equal(canClearPluginDevAgentHistory({
      hasHistory: true, status: 'waiting_user', busy: true
    }), false)
    assert.equal(canClearPluginDevAgentHistory({
      hasHistory: false, status: null, busy: false
    }), false)
  })

  it('auto-applies only unfinished history and leaves terminal editor state untouched', () => {
    assert.equal(isRecoverablePluginDevSessionStatus('running'), true)
    assert.equal(isRecoverablePluginDevSessionStatus('waiting_user'), true)
    assert.equal(isRecoverablePluginDevSessionStatus('completed'), false)
    assert.equal(shouldApplyInitialPluginDevSnapshot('running'), true)
    assert.equal(shouldApplyInitialPluginDevSnapshot('waiting_user'), true)
    assert.equal(shouldApplyInitialPluginDevSnapshot('completed'), false)
    assert.equal(shouldApplyInitialPluginDevSnapshot('failed'), false)
    assert.equal(shouldApplyInitialPluginDevSnapshot('cancelled'), false)
  })

  it('keeps non-debuggable built-ins out of the plugin-development selector', () => {
    const descriptor = (input: {
      name: string
      source: 'user' | 'builtin' | 'composite'
      debuggable: boolean
    }) => ({
      kind: 'video' as const,
      name: input.name,
      version: '1.0.0',
      description: '',
      source: input.source,
      removable: input.source !== 'builtin',
      exportable: input.debuggable,
      debuggable: input.debuggable,
      supportedFields: []
    })

    assert.deepEqual(listPluginDevSelectablePlugins([
      descriptor({ name: 'MetaTube', source: 'builtin', debuggable: false }),
      descriptor({ name: 'JavDB', source: 'builtin', debuggable: true }),
      descriptor({ name: 'Custom', source: 'user', debuggable: true }),
      descriptor({ name: 'Composite', source: 'composite', debuggable: false })
    ]), [
      { name: 'Custom', source: 'user' },
      { name: 'JavDB', source: 'builtin' }
    ])
  })

  it('does not treat a loaded built-in fork as the already-selected new-plugin option', () => {
    assert.deepEqual(pluginDevLoadedPluginIdentity('JavDB', 'builtin'), {
      selectedPluginName: 'JavDB',
      loadedInstalledName: null,
      forkedFromBuiltIn: 'JavDB'
    })
    assert.equal(shouldIgnorePluginDevSelection({
      nextName: '',
      selectedName: '',
      hasLoadedPlugin: true
    }), false)
    assert.equal(shouldIgnorePluginDevSelection({
      nextName: '',
      selectedName: '',
      hasLoadedPlugin: false
    }), true)
  })

  it('rejects session B events while continuing session A', () => {
    const operation: PluginDevLocalAgentOperation = {
      id: 1,
      kind: 'message',
      sessionId: 'session-a'
    }

    assert.equal(resolvePluginDevAgentEvent({
      eventSessionId: 'session-b',
      activeSessionId: 'session-a',
      operation,
      allowSnapshotBootstrap: false
    }).accepted, false)
    assert.equal(resolvePluginDevAgentEvent({
      eventSessionId: 'session-a',
      activeSessionId: 'session-a',
      operation,
      allowSnapshotBootstrap: false
    }).accepted, true)
  })

  it('binds an unbound start once and rejects later events from another session', () => {
    const operation: PluginDevLocalAgentOperation = { id: 2, kind: 'start', sessionId: null }
    const first = resolvePluginDevAgentEvent({
      eventSessionId: 'new-session',
      activeSessionId: null,
      operation,
      allowSnapshotBootstrap: false
    })

    assert.equal(first.accepted, true)
    assert.equal(first.sessionId, 'new-session')
    assert.equal(first.operation?.sessionId, 'new-session')
    assert.equal(resolvePluginDevAgentEvent({
      eventSessionId: 'other-session',
      activeSessionId: first.sessionId,
      operation: first.operation,
      allowSnapshotBootstrap: false
    }).accepted, false)
  })

  it('invalidates a snapshot after any newer live mutation', () => {
    const gate = createPluginDevSnapshotGate()
    const requestVersion = gate.begin()

    gate.observeMutation()

    assert.equal(gate.canApply(requestVersion), false)
    assert.equal(gate.canApply(gate.begin()), true)
  })

  it('releases restored busy state on settle but keeps a local API dispatch busy', () => {
    const waitingEvent = {
      type: 'waiting_user' as const,
      sessionId: 'session-a',
      step: 3,
      reason: 'approval'
    }
    const operation: PluginDevLocalAgentOperation = {
      id: 3,
      kind: 'message',
      sessionId: 'session-a'
    }

    assert.equal(shouldReleaseAgentBusyForEvent(waitingEvent, null), true)
    assert.equal(shouldReleaseAgentBusyForEvent(waitingEvent, operation), false)
    assert.equal(shouldReleaseAgentBusyForEvent({
      type: 'tool_start',
      sessionId: 'session-a',
      step: 3,
      tool: 'plugin_dry_run',
      args: {}
    }, null), false)
  })

  it('projects the final package from done immediately instead of waiting for the IPC promise', () => {
    const packageValue: ScraperPluginPackage = {
      schemaVersion: 1,
      kind: 'video',
      name: 'fixture',
      supportedFields: [
        'title',
        'summary',
        'cover',
        'releaseDate',
        'duration',
        'actressesFemale',
        'tags',
        'series',
        'maker',
        'source'
      ],
      code: 'module.exports = { async parseVideo() { return null } }'
    }
    const event = {
      type: 'done' as const,
      sessionId: 'session-a',
      step: 4,
      success: true,
      summary: 'done',
      package: packageValue
    }

    assert.equal(packageFromPluginDevAgentEvent(event), packageValue)
  })

  it('blocks ordinary messages until the exact pending approval is decided', () => {
    const approval: PluginDevPendingApproval = {
      requestId: 'approval-a',
      tool: 'browser',
      args: { action: 'type' },
      reason: 'sensitive input'
    }

    assert.deepEqual(checkPluginDevMessageDispatch(approval), {
      allowed: false,
      approval: null,
      reason: 'approval-required'
    })
    assert.equal(checkPluginDevMessageDispatch(approval, {
      requestId: 'approval-b',
      decision: 'approve'
    }).allowed, false)
    assert.deepEqual(checkPluginDevMessageDispatch(approval, {
      requestId: 'approval-a',
      decision: 'deny'
    }), {
      allowed: true,
      approval
    })
  })

  it('does not dispatch a stale approval after the request disappeared', () => {
    assert.deepEqual(checkPluginDevMessageDispatch(null, {
      requestId: 'approval-a',
      decision: 'approve'
    }), {
      allowed: false,
      approval: null,
      reason: 'unexpected-approval'
    })
  })
})
