import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { BatchProgress } from '@shared/types'
import { batchStatusLabel } from '../../settings/settingsDisplay'
import { SettingsEmptyPanel, SettingsStatusPill } from './SettingsPrimitives'
import BatchTaskControls, { type BatchControlHandler } from './BatchTaskControls'

type BatchScope = 'video' | 'actress'

export default function BatchSettingsPanel({
  scope,
  batch,
  running,
  paused,
  logRef,
  emptyLog,
  onPause,
  onResume,
  onDiscard
}: {
  scope: BatchScope
  batch: BatchProgress | null
  running: boolean
  paused: boolean
  logRef: RefObject<HTMLDivElement>
  emptyLog: string
  onPause: BatchControlHandler
  onResume: BatchControlHandler
  onDiscard: BatchControlHandler
}): JSX.Element {
  const didInitialScrollRef = useRef(false)
  const hasBatch = Boolean(batch && batch.status !== 'idle')
  const hasBatchLogs = (batch?.logs.length ?? 0) > 0
  const expandBatchCard = hasBatch || hasBatchLogs
  const status = batch?.status ?? 'idle'
  const remaining = batch ? Math.max(0, batch.total - batch.current) : null
  const taskNoun = scope === 'actress' ? '演员' : '影片'
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
    <div
      className={`settings-card settings-card--batch batch-status-${status}${
        expandBatchCard ? ' is-expanded' : ''
      }`}
    >
      <div className="batch-log-toolbar">
        <SettingsStatusPill status={status}>
          {batch ? batchStatusLabel(status) : '空闲'}
        </SettingsStatusPill>
        <BatchTaskControls
          scopeLabel={taskNoun}
          running={running}
          paused={paused}
          status={status}
          onPause={onPause}
          onResume={onResume}
          onDiscard={onDiscard}
        />
      </div>

      <div className="batch-log-stats" aria-label="运行统计">
        <div className="batch-log-stats-row">
          <span className="batch-log-stat">
            <span className="batch-log-stat-label">进度</span>
            <strong>{progressCount}</strong>
          </span>
          <span className="batch-log-stat">
            <span className="batch-log-stat-label">成功</span>
            <strong className="text-success">{batch?.success ?? 0}</strong>
          </span>
          <span className="batch-log-stat">
            <span className="batch-log-stat-label">失败</span>
            <strong className="text-danger">{batch?.failed ?? 0}</strong>
          </span>
          <span className="batch-log-stat">
            <span className="batch-log-stat-label">剩余</span>
            <strong>{remaining ?? '-'}</strong>
          </span>
          <span className="batch-log-stats-current" title={currentDetail}>
            {currentDetail}
          </span>
        </div>
        <div
          className="batch-log-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={safePercent}
          aria-label={`完成率 ${safePercent}%`}
        >
          <div className="batch-log-progress-track">
            <span style={{ width: `${safePercent}%` }} />
          </div>
          <strong className="batch-log-progress-pct">{safePercent}%</strong>
        </div>
      </div>

      <section className="batch-log-panel" aria-label={`${taskNoun}任务日志`}>
        <div className="batch-log-head">
          <span>执行日志</span>
          <small>{batch?.logs.length ?? 0} 条</small>
        </div>
        {batch?.logs.length ? (
          <div className="log-box log-box--batch copyable-text" ref={logRef}>
            {batch.logs.map((line, index) => (
              <div key={index} className={`log-line ${line.level}`}>
                [{new Date(line.time).toLocaleTimeString()}]{' '}
                {line.code !== '-' ? `${line.code} ` : ''}
                {line.message}
              </div>
            ))}
          </div>
        ) : (
          <SettingsEmptyPanel variant="compact" className="settings-empty-panel--batch">
            {emptyLog}
          </SettingsEmptyPanel>
        )}
      </section>
    </div>
  )
}
