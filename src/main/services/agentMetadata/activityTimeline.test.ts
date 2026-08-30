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

  it('retains up to 64,000 reasoning characters and reports overflow', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.observe({ type: 'reasoning.delta', text: '思'.repeat(64_010) })

    const reasoning = timeline.snapshot()[0]
    assert.equal(reasoning?.kind === 'reasoning' ? reasoning.text.length : 0, 64_000)
    assert.equal(reasoning?.kind === 'reasoning' ? reasoning.charCount : 0, 64_010)
    assert.equal(reasoning?.kind === 'reasoning' ? reasoning.truncated : false, true)
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

  it('describes playlist page checkpoints as result-producing actions', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.describeTool('page-1', 'checkpoint_playlist_page', {})
    timeline.describeTool('scroll-1', 'advance_playlist_page', {})
    timeline.describeTool('detail-1', 'checkpoint_playlist_detail', {})

    assert.deepEqual(timeline.snapshot().map((activity) => (
      activity.kind === 'action' ? activity.label : ''
    )), ['固化当前清单页', '进入下一清单窗口', '核对影片详情身份'])
  })

  it('describes browser scroll without exposing tool arguments', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.describeTool('scroll-1', 'browser', {
      action: 'scroll',
      target: '#private-list',
      direction: 'down'
    })

    const activity = timeline.snapshot()[0]
    assert.equal(activity?.kind === 'action' ? activity.label : '', '滚动页面内容')
  })

  it('retains earlier reasoning across browser-heavy runs', () => {
    const timeline = new AgentMetadataActivityTimeline()
    timeline.observe({ type: 'reasoning.delta', text: '最早一轮思考' })
    timeline.observe({
      type: 'message.completed',
      audit: { role: 'assistant', textPreview: '', contentHash: 'hash', reasoningChars: 7 },
      recovery: { codecVersion: 1, payload: '{}', contentHash: 'recovery' }
    })
    for (let index = 0; index < 300; index += 1) {
      timeline.describeTool(`call-${index}`, 'browser', { action: 'snapshot' })
    }

    const activities = timeline.snapshot()
    const earliest = activities.find((activity) => activity.id === 'reasoning:1')
    assert.equal(earliest?.kind === 'reasoning' ? earliest.text : '', '最早一轮思考')
    assert.equal(activities.length, 256)
  })

})
