import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import type {
  PluginDevAgentContextStats,
  PluginDevAgentPhase,
  PluginDevSessionStatus
} from '@shared/types'
import { formatToolLabel, toolCategory } from './pluginDevFormat'
import { agentPhaseLabel, type PluginDevConversationItem } from './types'

function compactNumber(value: number): string {
  if (value >= 1000) {
    const compact = value / 1000
    return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}k`
  }
  return value.toLocaleString()
}

function tokenK(value: number): string {
  const compact = value / 1000
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}k`
}

function contextPercent(stats: PluginDevAgentContextStats | null): number {
  if (!stats) return 0
  return Math.min(100, Math.round((stats.estimatedTokens / stats.maxTokens) * 100))
}

export default function PluginDevConversation({
  visible,
  items,
  activeTool,
  agentPhase,
  agentStep,
  contextStats,
  running,
  feedbackText,
  agentStatus,
  busy,
  canSend,
  canCancelAgent,
  waitingUserReason,
  onFeedbackChange,
  onSend,
  onCancelAgent,
  onContinueChallenge
}: {
  visible: boolean
  items: PluginDevConversationItem[]
  activeTool: string | null
  agentPhase: PluginDevAgentPhase
  agentStep: number
  contextStats: PluginDevAgentContextStats | null
  running: boolean
  feedbackText: string
  agentStatus: PluginDevSessionStatus | null
  busy: boolean
  canSend: boolean
  canCancelAgent: boolean
  waitingUserReason: string | null
  onFeedbackChange: (value: string) => void
  onSend: () => void
  onCancelAgent: () => void
  onContinueChallenge: () => void
}): JSX.Element {
  const logRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  const scrollToBottom = (instant: boolean) => {
    const el = logRef.current
    if (!el) return
    if (instant) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
  }

  useLayoutEffect(() => {
    if (visible) scrollToBottom(true)
  }, [visible])

  useEffect(() => {
    scrollToBottom(!visibleRef.current)
  }, [items.length, activeTool, running])

  const agentRunning = busy && agentStatus === 'running'

  const sendLabel =
    agentStatus === 'waiting_user' ||
    agentStatus === 'cancelled' ||
    agentStatus === 'failed' ||
    agentStatus === 'completed'
      ? '继续 Agent'
      : '发送给 Agent'

  const placeholder =
    agentStatus === 'waiting_user'
      ? '验证完成后点继续，或补充说明…'
      : agentStatus === 'running'
        ? 'Agent 运行中，请稍候…'
        : agentStatus === 'cancelled' || agentStatus === 'failed' || agentStatus === 'completed'
          ? '补充问题或继续指示，将继承上方对话上下文…'
          : '描述调试问题或指示，将基于当前插件代码开始调试…'

  return (
    <div className="plugin-dev-conversation">
      <div ref={logRef} className="plugin-dev-conversation-log">
        {items.length === 0 && !running ? (
          <div className="plugin-dev-agent-empty plugin-dev-agent-empty--compact">
            <strong>开始与 Agent 对话</strong>
            <span>填写配置后点击「AI开发 / AI调试」，或在底部输入指示开始调试。</span>
          </div>
        ) : (
          items.map((item) => {
            if (item.type === 'user') {
              return (
                <div key={item.id} className="plugin-dev-chat-message plugin-dev-chat-message--user">
                  <span>你</span>
                  <p>{item.text}</p>
                </div>
              )
            }
            if (item.type === 'agent') {
              return (
                <div key={item.id} className="plugin-dev-chat-message plugin-dev-chat-message--agent">
                  <span>Agent</span>
                  <p>{item.text}</p>
                </div>
              )
            }
            const category = toolCategory(item.tool)
            const state = item.ok === false ? 'is-fail' : item.ok === true ? 'is-ok' : ''
            return (
              <div key={item.id} className={`plugin-dev-conv-tool ${state}`}>
                <div className="plugin-dev-conv-tool-head">
                  <span className="plugin-dev-conv-tool-label">工具</span>
                  <span className={`plugin-dev-timeline-tool plugin-dev-timeline-tool--${category}`}>
                    {formatToolLabel(item.tool)}
                  </span>
                  <span className="plugin-dev-conv-tool-step">#{item.step}</span>
                </div>
                {(item.detail || item.summary) && (
                  <details className="plugin-dev-conv-tool-detail" open={item.ok === false}>
                    <summary>查看输出</summary>
                    <pre>{item.detail || item.summary}</pre>
                  </details>
                )}
              </div>
            )
          })
        )}

        {running && activeTool && (
          <div className="plugin-dev-conv-tool is-pending">
            <div className="plugin-dev-conv-tool-head">
              <span className="plugin-dev-conv-tool-label">工具</span>
              <span
                className={`plugin-dev-timeline-tool plugin-dev-timeline-tool--${toolCategory(activeTool)}`}
              >
                {formatToolLabel(activeTool)}
              </span>
              <span className="plugin-dev-conv-tool-step">{agentPhaseLabel(agentPhase)}</span>
              {agentStep > 0 && <span className="plugin-dev-conv-tool-step">#{agentStep}</span>}
              <span className="plugin-dev-timeline-muted">执行中…</span>
            </div>
          </div>
        )}
      </div>

      <div className="plugin-dev-composer-stack">
        {waitingUserReason ? (
          <div className="plugin-dev-user-prompt" role="status" aria-live="polite">
            <div className="plugin-dev-user-prompt-copy">
              <span className="plugin-dev-user-prompt-kicker">需要你的操作</span>
              <p>{waitingUserReason}</p>
            </div>
            <button
              type="button"
              className="btn btn-sm btn-primary plugin-dev-user-prompt-action"
              disabled={busy}
              onClick={onContinueChallenge}
            >
              验证完成，继续
            </button>
          </div>
        ) : null}

        <div className="plugin-dev-chat-composer">
          <textarea
            className="text-input plugin-dev-feedback-input"
            value={feedbackText}
            placeholder={placeholder}
            disabled={busy && agentStatus === 'running'}
            onChange={(e) => onFeedbackChange(e.target.value)}
            onKeyDown={(e) => {
              if (agentRunning) return
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                onSend()
              }
            }}
          />
          <div className="plugin-dev-chat-actions">
            <span>{agentRunning ? '任务运行中' : 'Ctrl+Enter 发送'}</span>
            <div className="plugin-dev-chat-action-end">
              <div
                className="plugin-dev-context-popover"
                style={
                  {
                    '--context-percent': `${contextPercent(contextStats)}%`
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className={`plugin-dev-context-trigger${contextStats?.overBudget ? ' is-warn' : ''}`}
                  aria-label={`背景信息窗口：${contextPercent(contextStats)}% 已用`}
                >
                  <span />
                </button>
                <div className="plugin-dev-context-card" role="tooltip">
                  <span className="plugin-dev-context-title">背景信息窗口</span>
                  <span className="plugin-dev-context-percent">{contextPercent(contextStats)}% 已用</span>
                  <span className="plugin-dev-context-detail">
                    已用 {compactNumber(contextStats?.estimatedTokens ?? 0)} 标记，上限 {compactNumber(contextStats?.maxTokens ?? 128000)}
                  </span>
                  <span className="plugin-dev-context-detail">
                    本次对话 {tokenK(contextStats?.totalTokens ?? 0)} token
                  </span>
                  {contextStats?.overBudget ? (
                    <span className="plugin-dev-context-warning">旧消息已按预算裁剪</span>
                  ) : null}
                </div>
              </div>
              {agentRunning ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={!canCancelAgent}
                  onClick={onCancelAgent}
                >
                  终止
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={busy || !canSend || feedbackText.trim().length === 0}
                  onClick={onSend}
                >
                  {sendLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
