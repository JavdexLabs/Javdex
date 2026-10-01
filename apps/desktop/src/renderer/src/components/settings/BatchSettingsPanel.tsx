import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import { batchStatusLabel } from '../../settings/settingsDisplay'
import { SettingsCard, SettingsEmptyPanel, SettingsStatusPill } from './SettingsPrimitives'
import BatchTaskControls, { type BatchControlHandler } from './BatchTaskControls'
import Button from '../Button'
import StatusText from '../StatusText'
import styles from './BatchSettingsPanel.module.css'

const LOG_LEVEL_CLASS = {
  info: styles.logLineInfo,
  success: styles.logLineSuccess,
  error: styles.logLineError
}

type BatchScope = 'video' | 'actress' | 'avatar'

export default function BatchSettingsPanel({
  scope,
  batch,
  running,
  paused,
  canResume = true,
  resumeDisabledReason = null,
  logRef,
  emptyLog,
  logNotice,
  skipped,
  customControls,
  pendingGroupCount = 0,
  onOpenPending,
  onPause,
  onResume,
  onDiscard
}: {
  scope: BatchScope
  batch: BatchProgress | null
  running: boolean
  paused: boolean
  canResume?: boolean
  resumeDisabledReason?: string | null
  logRef: RefObject<HTMLDivElement>
  emptyLog: string
  logNotice?: string
  skipped?: number
  customControls?: ReactNode
  pendingGroupCount?: number
  onOpenPending?: () => void
  onPause: BatchControlHandler
  onResume: BatchControlHandler
  onDiscard: BatchControlHandler
}): JSX.Element {
  const didInitialScrollRef = useRef(false)
  const hasBatch = Boolean(batch && batch.status !== 'idle')
  const status = batch?.status ?? 'idle'
  const remaining = batch ? Math.max(0, batch.total - batch.current) : null
  const taskNoun = scope === 'actress' ? '演员' : scope === 'avatar' ? '头像构图' : '影片'
  const progressCount = batch ? `${batch.current}/${batch.total}` : '未开始'
  const percent =
    batch && batch.total > 0 ? Math.round((batch.current / batch.total) * 100) : 0
  const safePercent = hasBatch ? Math.max(0, Math.min(percent, 100)) : 0
  const currentDetail = batch?.currentCode
    ? `当前 ${batch.currentCode}`
    : hasBatch
      ? batchStatusLabel(status)
      : `等待配置${taskNoun}任务范围`
  const logCount = batch?.logs.length ?? 0

  useLayoutEffect(() => {
    if (didInitialScrollRef.current) return
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    didInitialScrollRef.current = true
  }, [logCount, logRef])

  return (
    <SettingsCard className={styles.root}>
      <div className={styles.toolbar}>
        <SettingsStatusPill status={!canResume && paused ? 'paused' : status}>
          {batch ? (!canResume && paused ? '不可恢复' : batchStatusLabel(status)) : '空闲'}
        </SettingsStatusPill>
        <div className={styles.toolbarActions}>
          {scope !== 'avatar' && pendingGroupCount > 0 && onOpenPending ? (
            <Button type="button" variant="ghost" size="sm" onClick={onOpenPending}>
              查看待确认
            </Button>
          ) : null}
          {customControls !== undefined ? (
            customControls
          ) : (
            <BatchTaskControls
              scopeLabel={taskNoun}
              running={running}
              paused={paused}
              status={status}
              canResume={canResume}
              resumeDisabledReason={resumeDisabledReason}
              onPause={onPause}
              onResume={onResume}
              onDiscard={onDiscard}
            />
          )}
        </div>
      </div>

      {!canResume && paused ? (
        <p className={styles.unrecoverable} role="status">
          {resumeDisabledReason ?? '状态范围无法识别，请终止后重新启动任务'}
        </p>
      ) : null}

      <div className={styles.stats} aria-label="运行统计">
        <div
          className={`${styles.statsRow}${scope !== 'avatar' ? ` ${styles.statsRowWithPending}` : ''}`}
        >
          <span className={styles.stat}>
            <span className={styles.statLabel}>进度</span>
            <strong>{progressCount}</strong>
          </span>
          <span className={styles.stat}>
            <span className={styles.statLabel}>成功</span>
            <StatusText as="strong" tone="success">{batch?.success ?? 0}</StatusText>
          </span>
          {scope !== 'avatar' ? (
            <span className={`${styles.stat} ${styles.statPending}`}>
              <span className={styles.statLabel}>待确认</span>
              <strong>{pendingGroupCount}</strong>
            </span>
          ) : null}
          <span className={styles.stat}>
            <span className={styles.statLabel}>失败</span>
            <StatusText as="strong" tone="danger">{batch?.failed ?? 0}</StatusText>
          </span>
          <span className={styles.stat}>
            <span className={styles.statLabel}>{skipped === undefined ? '剩余' : '跳过'}</span>
            <strong>{skipped ?? remaining ?? '-'}</strong>
          </span>
          <span className={styles.statsCurrent} title={currentDetail}>
            {currentDetail}
          </span>
        </div>
        <div
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safePercent}
          aria-label={`完成率 ${safePercent}%`}
        >
          <div className={styles.progressTrack}>
            <span style={{ width: `${safePercent}%` }} />
          </div>
          <strong className={styles.progressPct}>{safePercent}%</strong>
        </div>
      </div>

      <section className={styles.logPanel} aria-label={`${taskNoun}任务日志`}>
        <div className={styles.logHead}>
          <span>执行日志</span>
          <small>{batch?.logs.length ?? 0} 条</small>
        </div>
        {logNotice ? (
          <div className={styles.logHead}>
            <small>{logNotice}</small>
          </div>
        ) : null}
        {batch?.logs.length ? (
          <div className={styles.logBox} ref={logRef}>
            {batch.logs.map((line, index) => (
              <div
                key={index}
                className={`${styles.logLine} ${LOG_LEVEL_CLASS[line.level]}`}
                data-batch-log-line
              >
                [{new Date(line.time).toLocaleTimeString()}]{' '}
                {line.code !== '-' ? `${line.code} ` : ''}
                {line.message}
              </div>
            ))}
          </div>
        ) : (
          <SettingsEmptyPanel variant="compact" className={styles.emptyPanel}>
            {emptyLog}
          </SettingsEmptyPanel>
        )}
      </section>
    </SettingsCard>
  )
}
