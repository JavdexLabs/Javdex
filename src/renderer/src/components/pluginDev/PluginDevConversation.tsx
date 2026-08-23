import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { Bot, BrainCircuit, Download, Trash2 } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import type {
  PluginDevAgentContextStats,
  PluginDevAgentPhase,
  PluginDevPendingApproval,
  PluginDevPendingUserRequest,
  PluginDevSessionStatus
} from '@shared/pluginDevTypes'
import { formatToolLabel, toolCategory } from './pluginDevFormat'
import EmptyState from '../EmptyState'
import { UI_ICON_SM } from '../iconDefaults'
import { agentPhaseLabel, type PluginDevConversationItem } from './types'
import Button from '../Button'
import styles from './PluginDevConversation.module.css'

type ReasoningItem = Extract<PluginDevConversationItem, { type: 'reasoning' }>

function ReasoningBlock({ item }: { item: ReasoningItem }): JSX.Element {
  const contentRef = useRef<HTMLPreElement | null>(null)
  const followRef = useRef(true)

  useLayoutEffect(() => {
    if (!item.streaming) {
      followRef.current = true
      return
    }
    const el = contentRef.current
    if (!el || !followRef.current) return
    el.scrollTop = el.scrollHeight
  }, [item.text, item.streaming])

  const handleContentScroll = (): void => {
    const el = contentRef.current
    if (!el) return
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  return (
    <details
      className={styles.reasoning}
      open={item.streaming || undefined}
      aria-busy={item.streaming || undefined}
    >
      <summary
        className={styles.reasoningSummary}
        title="模型供应商返回的 reasoning 内容"
      >
        <span className={styles.reasoningHead}>
          <BrainCircuit {...UI_ICON_SM} aria-hidden />
          <span className={styles.reasoningLabel}>模型推理</span>
          {item.streaming ? <span className={styles.streamingState}>思考中…</span> : null}
        </span>
        <span className={styles.reasoningMeta}>
          第 {item.turn} 轮{item.step > 0 ? ` · #${item.step}` : ''}
          <span className={styles.reasoningChars}>
            {` · ${item.charCount.toLocaleString('zh-CN')} 字符`}
          </span>
        </span>
        {!item.streaming ? (
          <span className={styles.reasoningPreview} data-reasoning-preview>
            {reasoningPreview(item.text)}
          </span>
        ) : null}
      </summary>
      <pre
        ref={contentRef}
        className={styles.reasoningContent}
        onScroll={handleContentScroll}
      >
        {item.text}
      </pre>
      {item.truncated ? (
        <p className={styles.reasoningNotice}>内容过长，界面仅保留前 64,000 字符。</p>
      ) : null}
    </details>
  )
}

function AgentMarkdown({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => <h1 className={styles.mdHeading}>{children}</h1>,
        h2: ({ children }) => <h2 className={styles.mdHeading}>{children}</h2>,
        h3: ({ children }) => <h3 className={styles.mdHeading}>{children}</h3>,
        h4: ({ children }) => <h4 className={styles.mdHeading}>{children}</h4>,
        p: ({ children }) => <p className={styles.mdParagraph}>{children}</p>,
        ul: ({ children }) => <ul className={styles.mdList}>{children}</ul>,
        ol: ({ children }) => <ol className={styles.mdList}>{children}</ol>,
        li: ({ children }) => <li className={styles.mdItem}>{children}</li>,
        a: ({ href, children }) => (
          <a
            className={styles.mdLink}
            href={href}
            onClick={(event) => {
              event.preventDefault()
              if (href) void window.api.externalLinks.open(href)
            }}
          >
            {children}
          </a>
        ),
        code: ({ className, children }) => (
          <code className={className ? styles.mdCodeBlock : styles.mdCode}>{children}</code>
        ),
        pre: ({ children }) => <pre className={styles.mdPre}>{children}</pre>,
        blockquote: ({ children }) => <blockquote className={styles.mdQuote}>{children}</blockquote>,
        hr: () => <hr className={styles.mdRule} />
      }}
    >
      {text}
    </ReactMarkdown>
  )
}

function tokenK(value: number): string {
  const compact = value / 1000
  return `${compact >= 10 ? compact.toFixed(0) : compact.toFixed(1)}k`
}

function tokenWindowRatio(stats: PluginDevAgentContextStats | null): string {
  return `${tokenK(stats?.estimatedTokens ?? 0)} / ${tokenK(stats?.maxTokens ?? 128000)}`
}

function contextPercent(stats: PluginDevAgentContextStats | null): number {
  if (!stats || stats.maxTokens <= 0) return 0
  return Math.min(100, Math.round((stats.estimatedTokens / stats.maxTokens) * 100))
}

function cacheHitRatio(stats: PluginDevAgentContextStats | null): string {
  const uncachedInput = Math.max(0, stats?.inputTokens ?? 0)
  const cacheRead = Math.max(0, stats?.cacheReadTokens ?? 0)
  const cacheableInput = uncachedInput + cacheRead
  if (cacheableInput === 0) return '—'
  return `${Math.round((cacheRead / cacheableInput) * 100)}%`
}

function reasoningPreview(value: string): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > 160 ? `${compact.slice(0, 159)}…` : compact
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
  canClearHistory,
  clearHistoryBusy,
  canExportWorkLog,
  exportWorkLogBusy,
  waitingUserReason,
  artifactReady = false,
  pendingApproval,
  pendingUserRequest,
  onFeedbackChange,
  onSend,
  onCancelAgent,
  onClearHistory,
  onContinueBrowserInteraction,
  onFieldMapping,
  onApprovalDecision,
  onExportWorkLog
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
  canClearHistory: boolean
  clearHistoryBusy: boolean
  canExportWorkLog: boolean
  exportWorkLogBusy: boolean
  waitingUserReason: string | null
  artifactReady?: boolean
  pendingApproval: PluginDevPendingApproval | null
  pendingUserRequest: PluginDevPendingUserRequest | null
  onFeedbackChange: (value: string) => void
  onSend: () => void
  onCancelAgent: () => void
  onClearHistory: () => void
  onContinueBrowserInteraction: () => void
  onFieldMapping: (optionId: string) => void
  onApprovalDecision: (decision: 'approve' | 'deny') => void
  onExportWorkLog: () => void
}): JSX.Element {
  const logRef = useRef<HTMLDivElement | null>(null)
  const visibleRef = useRef(visible)
  const followTailRef = useRef(true)
  visibleRef.current = visible
  const streamedContentLength = items.reduce(
    (total, item) => total + (
      item.type === 'agent' || item.type === 'reasoning' ? item.text.length : 0
    ),
    0
  )
  const interactionRevision = pendingApproval?.requestId
    ?? pendingUserRequest?.requestId
    ?? waitingUserReason
    ?? ''

  const scrollToBottom = (instant: boolean) => {
    const el = logRef.current
    if (!el) return
    if (instant) {
      el.scrollTop = el.scrollHeight
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    }
    followTailRef.current = true
  }

  useLayoutEffect(() => {
    if (visible) scrollToBottom(true)
  }, [visible])

  useEffect(() => {
    if (visibleRef.current && !followTailRef.current) return
    scrollToBottom(!visibleRef.current || running)
  }, [items.length, streamedContentLength, activeTool, running, interactionRevision])

  const handleLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const agentRunning = busy && agentStatus === 'running'
  const primaryUsage = contextStats?.usageByRole?.primary

  const sendLabel =
    agentStatus === 'waiting_user' ||
    agentStatus === 'cancelled' ||
    agentStatus === 'failed' ||
    agentStatus === 'completed'
      ? '继续 Agent'
      : '发送给 Agent'

  const placeholder =
    pendingApproval
      ? '请先批准或拒绝上方待处理操作…'
      : pendingUserRequest?.type === 'choice'
          ? '请先选择上方选项…'
        : pendingUserRequest?.type === 'browser_challenge' || pendingUserRequest?.type === 'browser_interaction'
          ? '请先在浏览器中完成必要操作…'
          : pendingUserRequest?.type === 'freeform'
            ? '请输入对上方问题的回复…'
      : agentStatus === 'waiting_user'
      ? artifactReady
        ? '如需继续完善，请先输入具体反馈…'
        : '补充下一步要求后继续…'
      : agentStatus === 'running'
        ? 'Agent 运行中，请稍候…'
        : agentStatus === 'cancelled' || agentStatus === 'failed' || agentStatus === 'completed'
          ? '补充问题或继续指示，将继承上方对话上下文…'
          : '描述调试问题或指示，将基于当前插件代码开始调试…'

  const currentInteraction = pendingApproval ? (
    <div className={styles.userPrompt} role="status" aria-live="polite">
      <div className={styles.userPromptCopy}>
        <span className={styles.userPromptKicker}>需要操作批准</span>
        <p>{pendingApproval.reason}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={styles.userPromptAction}
        disabled={busy}
        onClick={() => onApprovalDecision('deny')}
      >
        拒绝
      </Button>
      <Button
        type="button"
        variant="primary"
        size="sm"
        className={styles.userPromptAction}
        disabled={busy}
        onClick={() => onApprovalDecision('approve')}
      >
        批准本次
      </Button>
    </div>
  ) : pendingUserRequest?.type === 'browser_challenge' || pendingUserRequest?.type === 'browser_interaction' ? (
    <div className={styles.userPrompt} role="status" aria-live="polite">
      <div className={styles.userPromptCopy}>
        <span className={styles.userPromptKicker}>
          {pendingUserRequest.type === 'browser_challenge' || pendingUserRequest.reason === 'human_verification'
            ? '浏览器验证'
            : pendingUserRequest.reason === 'login'
              ? '需要登录'
              : '需要浏览器操作'}
        </span>
        <p>{pendingUserRequest.prompt}</p>
      </div>
      <Button
        type="button"
        variant="primary"
        size="sm"
        className={styles.userPromptAction}
        disabled={busy}
        onClick={onContinueBrowserInteraction}
      >
        我已完成，继续
      </Button>
    </div>
  ) : pendingUserRequest?.type === 'choice' ? (
    <div className={styles.userPrompt} role="status" aria-live="polite">
      <div className={styles.userPromptCopy}>
        <span className={styles.userPromptKicker}>Agent 需要你决定</span>
        <p>{pendingUserRequest.prompt}</p>
        {pendingUserRequest.evidenceRefs.length > 0 ? (
          <small>{pendingUserRequest.evidenceRefs.join(' · ')}</small>
        ) : null}
      </div>
      {pendingUserRequest.options.map((option) => (
        <Button
          key={option.id}
          type="button"
          variant="ghost"
          size="sm"
          className={styles.userPromptAction}
          disabled={busy}
          title={option.description}
          onClick={() => onFieldMapping(option.id)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  ) : pendingUserRequest?.type === 'freeform' ? (
    <div className={styles.userPrompt} role="status" aria-live="polite">
      <div className={styles.userPromptCopy}>
        <span className={styles.userPromptKicker}>Agent 需要补充信息</span>
        <p>{pendingUserRequest.prompt}</p>
      </div>
    </div>
  ) : waitingUserReason ? (
    <div
      className={styles.settledNotice}
      data-ready={artifactReady || undefined}
      role="status"
      aria-live="polite"
    >
      <div className={styles.settledNoticeCopy}>
        <span className={styles.settledNoticeKicker}>
          {artifactReady ? '当前版本可安装' : 'Agent 本轮已结束'}
        </span>
        <p>{waitingUserReason}</p>
      </div>
    </div>
  ) : null

  return (
    <div className="plugin-dev-conversation">
      <div ref={logRef} className="plugin-dev-conversation-log" onScroll={handleLogScroll}>
        {items.length === 0 && !running && !currentInteraction ? (
          <EmptyState
            variant="fill"
            className="plugin-dev-agent-empty"
            icon={<Bot {...UI_ICON_SM} aria-hidden />}
            title="开始与 Agent 对话"
            description="填写配置后点击「AI开发 / AI调试」，或在底部输入指示开始调试。"
          />
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
                <div
                  key={item.id}
                  className="plugin-dev-chat-message plugin-dev-chat-message--agent"
                  aria-busy={item.streaming || undefined}
                >
                  <span>
                    Agent
                    {item.streaming ? <em className={styles.streamingState}>回答中…</em> : null}
                  </span>
                  <div className={styles.agentBody}>
                    {item.text ? <AgentMarkdown text={item.text} /> : null}
                    {item.streaming ? <i className={styles.streamingCursor} aria-hidden /> : null}
                  </div>
                </div>
              )
            }
            if (item.type === 'reasoning') {
              return <ReasoningBlock key={item.id} item={item} />
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

        {currentInteraction}
      </div>

      <div className="plugin-dev-composer-stack">
        <div className="plugin-dev-chat-composer">
          <textarea
            className="text-input plugin-dev-feedback-input"
            value={feedbackText}
            placeholder={placeholder}
            disabled={
              Boolean(pendingApproval) ||
              (Boolean(pendingUserRequest) && pendingUserRequest?.type !== 'freeform') ||
              (busy && agentStatus === 'running')
            }
            onChange={(e) => onFeedbackChange(e.target.value)}
            onKeyDown={(e) => {
              if (agentRunning) return
              if (e.nativeEvent.isComposing) return
              if (
                e.key === 'Enter' &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.shiftKey &&
                !e.altKey
              ) {
                e.preventDefault()
                onSend()
              }
            }}
          />
          <div className="plugin-dev-chat-actions">
            <span>{agentRunning ? '任务运行中' : 'Enter 发送 · Ctrl+Enter 换行'}</span>
            <div className="plugin-dev-chat-action-end">
              <div
                className={styles.contextPopover}
                style={
                  {
                    '--context-percent': `${contextPercent(contextStats)}%`
                  } as CSSProperties
                }
              >
                <button
                  type="button"
                  className={styles.contextTrigger}
                  data-warning={contextStats?.overBudget || undefined}
                  aria-label={`上下文信息窗口：已用 ${contextPercent(contextStats)}%`}
                >
                  <span className={styles.contextRing} />
                </button>
                <div className={styles.contextCard} role="tooltip">
                  <div className={styles.contextHeader}>
                    <div className={styles.contextHeaderCopy}>
                      <span className={styles.contextTitle}>上下文</span>
                      <span className={styles.contextActive} data-context-metric="active">
                        当前输入
                        <strong>{tokenWindowRatio(contextStats)}</strong>
                      </span>
                    </div>
                    <strong className={styles.contextPercent}>{contextPercent(contextStats)}%</strong>
                  </div>
                  <div className={styles.contextMeter} aria-hidden>
                    <span className={styles.contextMeterFill} />
                  </div>
                  <section className={styles.contextSection}>
                    <span className={styles.contextSectionTitle}>会话累计</span>
                    <dl className={styles.contextMetrics}>
                      <div data-context-metric="total">
                        <dt>总用量</dt>
                        <dd>{tokenK(contextStats?.totalTokens ?? 0)} tokens</dd>
                      </div>
                      <div
                        data-context-metric="cache-hit"
                        title="缓存读取 /（非缓存输入 + 缓存读取）"
                      >
                        <dt>缓存命中率</dt>
                        <dd>{cacheHitRatio(contextStats)}</dd>
                      </div>
                      <div data-context-metric="input">
                        <dt>非缓存输入</dt>
                        <dd>{tokenK(contextStats?.inputTokens ?? 0)}</dd>
                      </div>
                      <div data-context-metric="cache-read">
                        <dt>缓存读取</dt>
                        <dd>{tokenK(contextStats?.cacheReadTokens ?? 0)}</dd>
                      </div>
                      <div data-context-metric="cache-write">
                        <dt>缓存写入</dt>
                        <dd>{tokenK(contextStats?.cacheWriteTokens ?? 0)}</dd>
                      </div>
                      <div data-context-metric="output">
                        <dt>模型输出</dt>
                        <dd>{tokenK(contextStats?.outputTokens ?? 0)}</dd>
                      </div>
                      <div data-context-metric="reasoning">
                        <dt>推理</dt>
                        <dd>{tokenK(contextStats?.reasoningTokens ?? 0)}</dd>
                      </div>
                    </dl>
                  </section>
                  {primaryUsage ? (
                    <section className={styles.contextSection}>
                      <span className={styles.contextSectionTitle}>Primary 累计</span>
                      <dl className={styles.contextMetrics}>
                        <div data-context-metric="primary-input">
                          <dt>输入</dt>
                          <dd>{tokenK(primaryUsage.uncachedInput)}</dd>
                        </div>
                        <div data-context-metric="primary-cache-read">
                          <dt>缓存</dt>
                          <dd>{tokenK(primaryUsage.cacheRead)}</dd>
                        </div>
                        <div data-context-metric="primary-output">
                          <dt>输出</dt>
                          <dd>{tokenK(primaryUsage.output)}</dd>
                        </div>
                        <div data-context-metric="primary-reasoning">
                          <dt>推理</dt>
                          <dd>{tokenK(primaryUsage.reasoning)}</dd>
                        </div>
                      </dl>
                    </section>
                  ) : null}
                  {contextStats?.overBudget ? (
                    <span className={styles.contextWarning}>已超过配置的上下文安全线</span>
                  ) : null}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canClearHistory}
                title="关闭全部历史会话，下次进入时不再自动恢复"
                onClick={onClearHistory}
              >
                <Trash2 {...UI_ICON_SM} aria-hidden />
                {clearHistoryBusy ? '清除中…' : '清除会话'}
              </Button>
              <Button
                type="button"
                variant="ghost"

                size="sm"
                disabled={!canExportWorkLog || exportWorkLogBusy}
                title="导出完整 Agent 工作日志（JSON）"
                onClick={onExportWorkLog}
              >
                <Download {...UI_ICON_SM} aria-hidden />
                {exportWorkLogBusy ? '导出中…' : '导出日志'}
              </Button>
              {agentRunning ? (
                <Button
                  type="button"
                  variant="danger"

                  size="sm"
                  disabled={!canCancelAgent}
                  onClick={onCancelAgent}
                >
                  终止
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"

                  size="sm"
                  disabled={busy || !canSend || feedbackText.trim().length === 0}
                  onClick={onSend}
                >
                  {sendLabel}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
