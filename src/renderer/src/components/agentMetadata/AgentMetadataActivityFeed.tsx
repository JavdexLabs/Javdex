import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleX,
  Database,
  Globe2,
  LoaderCircle,
  UserRoundCheck
} from 'lucide-react'
import type {
  AgentMetadataActivity,
  AgentMetadataSnapshot
} from '@shared/agentMetadataTypes'
import { UI_ICON_SM } from '../iconDefaults'
import styles from './AgentMetadataActivityFeed.module.css'

type ReasoningActivity = Extract<AgentMetadataActivity, { kind: 'reasoning' }>
type ActionActivity = Extract<AgentMetadataActivity, { kind: 'action' }>

function compactText(value: string, maxLength = 96): string {
  const compact = value.replace(/\s+/gu, ' ').trim()
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact
}

function phaseHint(snapshot: AgentMetadataSnapshot): string {
  if (snapshot.phase === 'preparing') return '正在校验采集结果并暂存图片。'
  if (snapshot.phase === 'waiting_user') return '已暂停，等待你完成必要的页面操作。'
  if (snapshot.phase === 'ready') return '采集已完成，可以在右侧检查结果。'
  if (snapshot.phase === 'applying') return '正在按右侧确认的预览写入媒体库。'
  if (snapshot.phase === 'applied') return '已按确认的方式更新媒体库。'
  if (snapshot.phase === 'routed_to_pending') return '候选存在身份冲突，已转入待处理中心。'
  if (snapshot.phase === 'discarded') return '这份采集草稿已丢弃。'
  if (snapshot.phase === 'failed') return '采集未完成，可以查看最后一步定位问题。'
  if (snapshot.phase === 'cancelled') return '本次采集已终止。'
  return '正在核对身份并读取可预览的元数据。'
}

function phaseLabel(snapshot: AgentMetadataSnapshot): string {
  if (snapshot.phase === 'collecting' || snapshot.phase === 'preparing') return '进行中'
  if (snapshot.phase === 'waiting_user') return '等待操作'
  if (snapshot.phase === 'ready') return '已完成'
  if (snapshot.phase === 'applying') return '应用中'
  if (snapshot.phase === 'applied') return '已应用'
  if (snapshot.phase === 'routed_to_pending') return '待处理'
  if (snapshot.phase === 'discarded') return '已丢弃'
  if (snapshot.phase === 'failed') return '失败'
  if (snapshot.phase === 'cancelled') return '已终止'
  return snapshot.phase
}

function actionStatus(activity: ActionActivity): string {
  if (activity.status === 'running') return '执行中'
  if (activity.status === 'error') return '失败'
  return '已完成'
}

function ActionIcon({ activity }: { activity: ActionActivity }): JSX.Element {
  if (activity.status === 'running') {
    return <LoaderCircle {...UI_ICON_SM} className={styles.spin} aria-hidden />
  }
  if (activity.status === 'error') return <CircleX {...UI_ICON_SM} aria-hidden />
  if (activity.tool === 'browser') return <Globe2 {...UI_ICON_SM} aria-hidden />
  if (activity.tool === 'submit_metadata_candidate') return <Database {...UI_ICON_SM} aria-hidden />
  return <CheckCircle2 {...UI_ICON_SM} aria-hidden />
}

function ReasoningItem({
  activity,
  expanded,
  onExpandedChange
}: {
  activity: ReasoningActivity
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const followTailRef = useRef(true)
  const streaming = activity.status === 'running'

  useLayoutEffect(() => {
    if (!streaming) {
      followTailRef.current = true
      return
    }
    const element = contentRef.current
    if (!element || !expanded || !followTailRef.current) return
    element.scrollTop = element.scrollHeight
  }, [activity.text, expanded, streaming])

  const handleContentScroll = (): void => {
    const element = contentRef.current
    if (!element) return
    followTailRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }

  return (
    <div className={styles.reasoningRow} data-status={activity.status}>
      <span className={styles.activityIcon} data-status={activity.status}>
        {streaming
          ? <LoaderCircle {...UI_ICON_SM} className={styles.spin} aria-hidden />
          : <BrainCircuit {...UI_ICON_SM} aria-hidden />}
      </span>
      <details
        className={styles.reasoning}
        open={expanded}
        aria-busy={streaming || undefined}
        onToggle={(event) => {
          // A controlled <details> also emits toggle when React changes `open`. Only treat a
          // state that differs from the controlled value as an explicit user interaction.
          if (event.currentTarget.open !== expanded) {
            onExpandedChange(event.currentTarget.open)
          }
        }}
      >
        <summary className={styles.reasoningSummary}>
          <span className={styles.reasoningHeading}>
            <strong className={styles.reasoningLabel}>{streaming ? '正在思考' : `第 ${activity.turn} 轮思考`}</strong>
            <span className={styles.reasoningMeta}>{streaming ? '实时生成' : '已完成'}</span>
            <span className={styles.expandIcon} data-expanded={expanded}>
              <ChevronDown {...UI_ICON_SM} aria-hidden />
            </span>
          </span>
          {!expanded && !streaming ? (
            <span className={styles.reasoningPreview}>{compactText(activity.text)}</span>
          ) : null}
        </summary>
        <div
          ref={contentRef}
          className={`${styles.reasoningContent} selectable-text`}
          onScroll={handleContentScroll}
        >
          {activity.text || '正在生成思考内容…'}
        </div>
        {activity.truncated ? (
          <div className={styles.reasoningNotice}>内容较长，仅保留前 6,000 个字符。</div>
        ) : null}
      </details>
    </div>
  )
}

function runningReasoningIds(activities: AgentMetadataActivity[]): Set<string> {
  return new Set(activities
    .filter((activity): activity is ReasoningActivity =>
      activity.kind === 'reasoning' && activity.status === 'running'
    )
    .map((activity) => activity.id))
}

export default function AgentMetadataActivityFeed({
  snapshot
}: {
  snapshot: AgentMetadataSnapshot
}): JSX.Element {
  const logRef = useRef<HTMLDivElement | null>(null)
  const followTailRef = useRef(true)
  const reasoningStatusesRef = useRef(new Map(
    snapshot.activities
      .filter((activity): activity is ReasoningActivity => activity.kind === 'reasoning')
      .map((activity) => [activity.id, activity.status])
  ))
  const [following, setFollowing] = useState(true)
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(
    () => runningReasoningIds(snapshot.activities)
  )
  const contentWeight = snapshot.activities.reduce(
    (total, activity) => total + (
      activity.kind === 'reasoning'
        ? activity.text.length
        : activity.label.length + (activity.summary?.length ?? 0)
    ),
    0
  )
  const lastActivity = snapshot.activities.at(-1)

  useLayoutEffect(() => {
    const previous = reasoningStatusesRef.current
    const current = new Map<string, ReasoningActivity['status']>()
    const openIds: string[] = []
    const closeIds: string[] = []

    snapshot.activities.forEach((activity) => {
      if (activity.kind !== 'reasoning') return
      current.set(activity.id, activity.status)
      const previousStatus = previous.get(activity.id)
      if (activity.status === 'running' && previousStatus === undefined) openIds.push(activity.id)
      if (activity.status === 'success' && previousStatus === 'running') closeIds.push(activity.id)
    })

    reasoningStatusesRef.current = current
    if (openIds.length === 0 && closeIds.length === 0) return
    setExpandedReasoning((existing) => {
      const next = new Set(existing)
      openIds.forEach((id) => next.add(id))
      closeIds.forEach((id) => next.delete(id))
      return next
    })
  }, [snapshot.activities])

  useLayoutEffect(() => {
    const element = logRef.current
    if (!element || !followTailRef.current) return
    element.scrollTop = element.scrollHeight
  }, [contentWeight, expandedReasoning, lastActivity?.id, lastActivity?.status])

  const scrollToLatest = useCallback((): void => {
    followTailRef.current = true
    setFollowing(true)
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [])

  const handleScroll = (): void => {
    const element = logRef.current
    if (!element) return
    const atTail = element.scrollHeight - element.scrollTop - element.clientHeight < 32
    followTailRef.current = atTail
    setFollowing((current) => current === atTail ? current : atTail)
  }

  const setReasoningExpanded = (activity: ReasoningActivity, expanded: boolean): void => {
    setExpandedReasoning((existing) => {
      const next = new Set(existing)
      if (expanded) next.add(activity.id)
      else next.delete(activity.id)
      return next
    })

    if (activity.status === 'success') {
      followTailRef.current = false
      setFollowing(false)
    } else if (expanded) {
      followTailRef.current = true
      setFollowing(true)
    }
  }

  const live = snapshot.phase === 'collecting' || snapshot.phase === 'preparing'

  return (
    <section className={styles.feed} aria-label="Agent 运行">
      <header className={styles.header} role="status" aria-live="polite">
        <span className={styles.agentIcon} data-live={live || undefined}>
          {live
            ? <LoaderCircle {...UI_ICON_SM} className={styles.spin} aria-hidden />
            : <Bot {...UI_ICON_SM} aria-hidden />}
        </span>
        <span className={styles.headerCopy}>
          <span className={styles.headerTitleLine}>
            <strong className={styles.paneTitle}>Agent 运行</strong>
            <span className={styles.phase} data-phase={snapshot.phase}>{phaseLabel(snapshot)}</span>
          </span>
          <span className={styles.summary}>{snapshot.summary}</span>
          <small className={styles.hint}>{phaseHint(snapshot)}</small>
        </span>
        <span className={styles.activityCount}>{snapshot.activities.length}</span>
      </header>

      <div className={styles.logFrame}>
        <div
          ref={logRef}
          className={styles.log}
          onScroll={handleScroll}
          aria-label="Agent 行动与思考记录"
        >
          {snapshot.activities.length === 0 ? (
            <div className={styles.emptyActivity}>
              {live
                ? <LoaderCircle {...UI_ICON_SM} className={styles.spin} aria-hidden />
                : <Bot {...UI_ICON_SM} aria-hidden />}
              <span>{live ? '正在等待模型的第一步行动…' : '本次运行没有可显示的行动记录。'}</span>
            </div>
          ) : snapshot.activities.map((activity) => activity.kind === 'reasoning' ? (
            <ReasoningItem
              key={activity.id}
              activity={activity}
              expanded={expandedReasoning.has(activity.id)}
              onExpandedChange={(expanded) => setReasoningExpanded(activity, expanded)}
            />
          ) : (
            <div key={activity.id} className={styles.actionRow} data-status={activity.status}>
              <span className={styles.activityIcon} data-status={activity.status}>
                <ActionIcon activity={activity} />
              </span>
              <span className={styles.actionCopy}>
                <span className={styles.actionHeading}>
                  <strong className={styles.actionLabel}>{activity.label}</strong>
                  <span className={styles.actionStatus} data-status={activity.status}>
                    {actionStatus(activity)}
                  </span>
                </span>
                {activity.summary ? <small className={styles.actionSummary}>{activity.summary}</small> : null}
              </span>
            </div>
          ))}
        </div>

        {!following && snapshot.activities.length > 0 ? (
          <button type="button" className={styles.latestButton} onClick={scrollToLatest}>
            回到最新
            <ChevronDown {...UI_ICON_SM} aria-hidden />
          </button>
        ) : null}
      </div>

      {snapshot.phase === 'waiting_user' && snapshot.handoff ? (
        <div className={styles.handoff} role="status">
          <UserRoundCheck {...UI_ICON_SM} aria-hidden />
          <span className={styles.handoffCopy}>
            <strong className={styles.handoffTitle}>需要你完成页面操作</strong>
            <small className={`${styles.handoffText} selectable-text`}>{snapshot.handoff.prompt}</small>
          </span>
        </div>
      ) : null}
    </section>
  )
}
