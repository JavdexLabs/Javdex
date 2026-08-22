import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { PluginDevPendingUserRequest } from '@shared/pluginDevTypes'
import PluginDevConversation from './PluginDevConversation'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('PluginDevConversation history controls', () => {
  it('presents a ready settlement as normal state and requires feedback to continue', () => {
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation
          visible
          items={[]}
          activeTool={null}
          agentPhase="ready"
          agentStep={4}
          contextStats={null}
          running={false}
          feedbackText=""
          agentStatus="waiting_user"
          busy={false}
          canSend
          canCancelAgent={false}
          canClearHistory={false}
          clearHistoryBusy={false}
          canExportWorkLog={false}
          exportWorkLogBusy={false}
          waitingUserReason="当前草稿机械验收通过，可以安装；如需继续完善，请先输入具体反馈。"
          artifactReady
          pendingApproval={null}
          pendingUserRequest={null}
          onFeedbackChange={() => undefined}
          onSend={() => undefined}
          onCancelAgent={() => undefined}
          onClearHistory={() => undefined}
          onContinueBrowserInteraction={() => undefined}
          onFieldMapping={() => undefined}
          onApprovalDecision={() => undefined}
          onExportWorkLog={() => undefined}
        />
      )
    })

    assert.equal(
      renderer?.root.findAllByType('span').some((span) => span.children.includes('当前版本可安装')),
      true
    )
    assert.match(renderer?.root.findByType('textarea').props.placeholder ?? '', /具体反馈/)
    const continueButton = renderer?.root
      .findAllByType('button')
      .find((button) => button.children.includes('继续 Agent'))
    assert.ok(continueButton)
    assert.equal(continueButton.props.disabled, true)
  })

  it('renders model reasoning as a quiet collapsed diagnostic block', () => {
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation
          visible
          items={[{
            id: 'reasoning-1',
            type: 'reasoning',
            step: 2,
            turn: 3,
            text: '页面事实已经完整，不应继续读取 artifact。',
            charCount: 24,
            truncated: false
          }]}
          activeTool={null}
          agentPhase="working"
          agentStep={2}
          contextStats={null}
          running={false}
          feedbackText=""
          agentStatus="completed"
          busy={false}
          canSend={false}
          canCancelAgent={false}
          canClearHistory={false}
          clearHistoryBusy={false}
          canExportWorkLog={false}
          exportWorkLogBusy={false}
          waitingUserReason={null}
          pendingApproval={null}
          pendingUserRequest={null}
          onFeedbackChange={() => undefined}
          onSend={() => undefined}
          onCancelAgent={() => undefined}
          onClearHistory={() => undefined}
          onContinueBrowserInteraction={() => undefined}
          onFieldMapping={() => undefined}
          onApprovalDecision={() => undefined}
          onExportWorkLog={() => undefined}
        />
      )
    })

    assert.ok(renderer)
    const details = renderer.root.findByType('details')
    assert.notEqual(details.props.open, true)
    assert.equal(
      renderer.root.findAllByType('span').some((span) => span.children.includes('模型推理')),
      true
    )
    assert.equal(
      renderer.root.findAllByType('span').some((span) =>
        span.children.includes('页面事实已经完整，不应继续读取 artifact。')
      ),
      true
    )
    assert.equal(
      renderer.root.findByType('pre').children.join(''),
      '页面事实已经完整，不应继续读取 artifact。'
    )
  })

  it('keeps live reasoning open and marks the answer as streaming', () => {
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation
          visible
          items={[
            {
              id: 'reasoning-live',
              type: 'reasoning',
              step: 1,
              turn: 1,
              text: '正在检查页面字段',
              charCount: 8,
              truncated: false,
              streaming: true
            },
            {
              id: 'assistant-live',
              type: 'agent',
              turn: 1,
              text: '我将修改插件',
              streaming: true
            }
          ]}
          activeTool={null}
          agentPhase="working"
          agentStep={1}
          contextStats={null}
          running
          feedbackText=""
          agentStatus="running"
          busy
          canSend={false}
          canCancelAgent
          canClearHistory={false}
          clearHistoryBusy={false}
          canExportWorkLog={false}
          exportWorkLogBusy={false}
          waitingUserReason={null}
          pendingApproval={null}
          pendingUserRequest={null}
          onFeedbackChange={() => undefined}
          onSend={() => undefined}
          onCancelAgent={() => undefined}
          onClearHistory={() => undefined}
          onContinueBrowserInteraction={() => undefined}
          onFieldMapping={() => undefined}
          onApprovalDecision={() => undefined}
          onExportWorkLog={() => undefined}
        />
      )
    })

    assert.equal(renderer?.root.findByType('details').props.open, true)
    const text = renderer?.root.findAllByType('span').flatMap((span) => span.children).join(' ')
    assert.match(text ?? '', /思考中/)
    assert.equal(renderer?.root.findByType('em').children.join(''), '回答中…')
  })

  it('renders compact context metrics with the cache-hit ratio', () => {
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation
          visible
          items={[]}
          activeTool={null}
          agentPhase="working"
          agentStep={3}
          contextStats={{
            messageCount: 3,
            originalChars: 0,
            compressedChars: 0,
            savedChars: 0,
            estimatedTokens: 16_000,
            totalTokens: 42_000,
            maxTokens: 128_000,
            overBudget: false,
            inputTokens: 24_000,
            outputTokens: 8_000,
            reasoningTokens: 6_000,
            cacheReadTokens: 12_000,
            cacheWriteTokens: 2_000,
            usageByRole: {
              primary: {
                uncachedInput: 20_000,
                cacheRead: 12_000,
                cacheWrite: 2_000,
                output: 8_000,
                reasoning: 6_000,
                totalTokens: 48_000
              }
            }
          }}
          running
          feedbackText=""
          agentStatus="running"
          busy
          canSend={false}
          canCancelAgent
          canClearHistory={false}
          clearHistoryBusy={false}
          canExportWorkLog={false}
          exportWorkLogBusy={false}
          waitingUserReason={null}
          pendingApproval={null}
          pendingUserRequest={null}
          onFeedbackChange={() => undefined}
          onSend={() => undefined}
          onCancelAgent={() => undefined}
          onClearHistory={() => undefined}
          onContinueBrowserInteraction={() => undefined}
          onFieldMapping={() => undefined}
          onApprovalDecision={() => undefined}
          onExportWorkLog={() => undefined}
        />
      )
    })

    const tooltip = renderer?.root.findByProps({ role: 'tooltip' })
    assert.ok(tooltip)
    for (const metric of [
      'active',
      'total',
      'cache-hit',
      'input',
      'cache-read',
      'cache-write',
      'output',
      'reasoning'
    ]) {
      assert.equal(
        tooltip.findAllByProps({ 'data-context-metric': metric }).length,
        1,
        `${metric} must have its own non-truncated metric cell`
      )
    }
    assert.equal(
      tooltip.findByProps({ 'data-context-metric': 'cache-hit' }).findByType('dd').children.join(''),
      '33%'
    )
  })

  it('exposes an explicit clear-session action for a restored historical run', () => {
    let clearCalls = 0
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation
          visible
          items={[]}
          activeTool={null}
          agentPhase="idle"
          agentStep={0}
          contextStats={null}
          running={false}
          feedbackText=""
          agentStatus="completed"
          busy={false}
          canSend={false}
          canCancelAgent={false}
          canClearHistory
          clearHistoryBusy={false}
          canExportWorkLog={false}
          exportWorkLogBusy={false}
          waitingUserReason={null}
          pendingApproval={null}
          pendingUserRequest={null}
          onFeedbackChange={() => undefined}
          onSend={() => undefined}
          onCancelAgent={() => undefined}
          onClearHistory={() => { clearCalls += 1 }}
          onContinueBrowserInteraction={() => undefined}
          onFieldMapping={() => undefined}
          onApprovalDecision={() => undefined}
          onExportWorkLog={() => undefined}
        />
      )
    })

    const button = renderer?.root
      .findAllByType('button')
      .find((candidate) => candidate.props.title === '关闭全部历史会话，下次进入时不再自动恢复')
    assert.ok(button)
    assert.equal(button.props.disabled, false)
    act(() => button.props.onClick())
    assert.equal(clearCalls, 1)
  })

  it('keeps typed choice, browser challenge and freeform requests as distinct controls', () => {
    let selected = ''
    let challengeCalls = 0
    const choice: PluginDevPendingUserRequest = {
      requestId: 'choice-1',
      type: 'choice',
      prompt: '發行商应映射到哪个字段？',
      evidenceRefs: ['.javdex/browser/page.json'],
      options: [
        { id: '1', label: '发行商', description: '可见标签' },
        { id: '2', label: '制作商', description: '链接路由' }
      ]
    }
    const base = {
      visible: true,
      items: [],
      activeTool: null,
      agentPhase: 'waiting_user' as const,
      agentStep: 2,
      contextStats: null,
      running: false,
      feedbackText: '',
      agentStatus: 'waiting_user' as const,
      busy: false,
      canSend: false,
      canCancelAgent: false,
      canClearHistory: false,
      clearHistoryBusy: false,
      canExportWorkLog: false,
      exportWorkLogBusy: false,
      waitingUserReason: null,
      pendingApproval: null,
      onFeedbackChange: () => undefined,
      onSend: () => undefined,
      onCancelAgent: () => undefined,
      onClearHistory: () => undefined,
      onContinueBrowserInteraction: () => { challengeCalls += 1 },
      onFieldMapping: (optionId: string) => { selected = optionId },
      onApprovalDecision: () => undefined,
      onExportWorkLog: () => undefined
    }
    act(() => {
      renderer = TestRenderer.create(
        <PluginDevConversation {...base} pendingUserRequest={choice} />
      )
    })
    const log = renderer?.root.findByProps({ className: 'plugin-dev-conversation-log' })
    assert.equal(
      log?.findAllByProps({ role: 'status' }).length,
      1,
      'the current interaction must participate in the scrollable conversation layout'
    )
    const option = renderer?.root
      .findAllByType('button')
      .find((candidate) => candidate.props.title === '链接路由')
    assert.ok(option)
    act(() => option.props.onClick())
    assert.equal(selected, '2')
    assert.equal(renderer?.root.findByType('textarea').props.disabled, true)

    act(() => {
      renderer?.update(
        <PluginDevConversation
          {...base}
          pendingUserRequest={{
            requestId: 'challenge-1',
            type: 'browser_challenge',
            prompt: '完成浏览器验证',
            url: 'https://missav.example'
          }}
        />
      )
    })
    const challenge = renderer?.root.findAllByType('button').find((candidate) =>
      candidate.children.includes('我已完成，继续')
    )
    assert.ok(challenge)
    act(() => challenge.props.onClick())
    assert.equal(challengeCalls, 1)

    act(() => {
      renderer?.update(
        <PluginDevConversation
          {...base}
          pendingUserRequest={{
            requestId: 'login-1',
            type: 'browser_interaction',
            reason: 'login',
            prompt: '请在浏览器中登录'
          }}
        />
      )
    })
    assert.equal(
      renderer?.root.findAllByType('span')
        .some((candidate) => candidate.children.includes('需要登录')),
      true
    )

    act(() => {
      renderer?.update(
        <PluginDevConversation
          {...base}
          pendingUserRequest={{
            requestId: 'freeform-1',
            type: 'freeform',
            prompt: '请补充登录要求'
          }}
        />
      )
    })
    assert.equal(renderer?.root.findByType('textarea').props.disabled, false)
  })
})
