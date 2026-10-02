import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginDevAgentEvent } from '@shared/pluginDevTypes'
import { emptyPluginDevRun, pluginDevRunReducer } from './pluginDevRunProjection'

test('run events update phase, approval and terminal facts without changing editor state', () => {
  let state = emptyPluginDevRun()
  const observe = (event: PluginDevAgentEvent) => { state = pluginDevRunReducer(state, { type: 'event', event, runtimeFingerprint: null }) }
  observe({ type: 'step_start', sessionId: 'run', step: 2 })
  assert.equal(state.agentStatus, 'running')
  observe({ type: 'approval_required', sessionId: 'run', step: 2, requestId: 'approval', tool: 'write', args: {}, reason: 'approve' })
  assert.equal(state.pendingApproval?.requestId, 'approval')
  observe({ type: 'error', sessionId: 'run', step: 2, message: 'failed' })
  assert.equal(state.agentStatus, 'failed')
  assert.equal(state.pendingApproval, null)
  assert.equal(state.conversationItems.at(-1)?.type, 'agent')
  state = pluginDevRunReducer(state, { type: 'patch', patch: { hasAgentHistory: true } })
  state = pluginDevRunReducer(state, { type: 'reset' })
  assert.equal(state.hasAgentHistory, true)
  assert.equal(state.agentStatus, null)
  assert.deepEqual(state.conversationItems, [])
})

test('unbounded tool messages are projected into a bounded conversation', () => {
  let state = emptyPluginDevRun()
  for (let i = 0; i < 150; i++) state = pluginDevRunReducer(state, { type: 'event', runtimeFingerprint: null,
    event: { type: 'assistant_text', sessionId: 'run', step: i, text: String(i) } })
  assert.equal(state.conversationItems.length, 120)
})
