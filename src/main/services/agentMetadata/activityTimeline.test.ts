import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { AgentMetadataActivityTimeline } from './activityTimeline'

describe('AgentMetadataActivityTimeline', () => {
  it('projects streaming reasoning into one bounded completed turn', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.observe({ type: 'reasoning.delta', text: '先核对番号，' })
    timeline.observe({ type: 'reasoning.delta', text: '再读取字段。' })

    const live = timeline.snapshot()[0]
    assert.equal(live?.kind, 'reasoning')
    assert.equal(live?.status, 'running')
    assert.equal(live?.kind === 'reasoning' ? live.text : '', '先核对番号，再读取字段。')

    timeline.observe({
      type: 'message.completed',
      audit: { role: 'assistant', textPreview: '', contentHash: 'hash', reasoningChars: 12 },
      recovery: { codecVersion: 1, payload: '{}', contentHash: 'recovery' }
    })
    const completed = timeline.snapshot()[0]
    assert.equal(completed?.status, 'success')
  })

  it('uses semantic browser actions while retaining safe completion summaries', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.observe({
      type: 'tool.started',
      call: { callId: 'call-1', toolName: 'browser', argsDigest: 'digest' }
    })
    timeline.describeTool('call-1', 'browser', { action: 'snapshot' })
    timeline.observe({
      type: 'tool.started',
      call: { callId: 'call-1', toolName: 'browser', argsDigest: 'digest' }
    })
    timeline.observe({
      type: 'tool.completed',
      result: { callId: 'call-1', toolName: 'browser', ok: true, summary: '已读取页面结构' },
      recovery: { codecVersion: 1, payload: '{}', contentHash: 'recovery' }
    })

    assert.deepEqual(timeline.snapshot(), [{
      id: 'action:call-1',
      kind: 'action',
      status: 'success',
      tool: 'browser',
      label: '读取页面结构',
      summary: '已读取页面结构'
    }])
  })

  it('keeps direct metadata submission distinct from browser inspection', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.describeTool('submit-1', 'submit_metadata_candidate', {})
    const activity = timeline.snapshot()[0]

    assert.equal(
      activity?.kind === 'action' ? activity.label : '',
      '验证并保存元数据候选'
    )
  })
})
