import type { CSSProperties, KeyboardEventHandler, RefObject } from 'react'
import type { BatchProgress } from '@shared/types'
import { Pause, Play, Settings2, Square } from 'lucide-react'
import { batchStatusLabel } from '../../settings/settingsDisplay'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsEmptyPanel, SettingsStatusPill, SettingsTabBar } from './SettingsPrimitives'

type BatchScope = 'video' | 'actress'

const BATCH_TABS = [
  { id: 'video' as const, label: '影片任务' },
  { id: 'actress' as const, label: '演员任务' }
]

export default function BatchSettingsPanel({
  scope,
  onScopeChange,
  title,
  hint,
  batch,
  percent,
  running,
  paused,
  anyBatchActive,
  logRef,
  emptyLog,
  onConfigure,
  onPause,
  onResume,
  onDiscard,
  onTabKeyDown
}: {
  scope: BatchScope
  onScopeChange: (scope: BatchScope) => void
  title: string
  hint: string
  batch: BatchProgress | null
  percent: number
  running: boolean
  paused: boolean
  anyBatchActive: boolean
  logRef: RefObject<HTMLDivElement>
  emptyLog: string
  onConfigure: () => void
  onPause: () => void
  onResume: () => void
  onDiscard: () => void
  onTabKeyDown: KeyboardEventHandler<HTMLDivElement>
}): JSX.Element {
  const hasBatch = Boolean(batch && batch.status !== 'idle')
  const hasBatchLogs = (batch?.logs.length ?? 0) > 0
  const expandBatchCard = hasBatch || hasBatchLogs
  const percentLabel = hasBatch ? `${percent}%` : '0%'
  const safePercent = hasBatch ? Math.max(0, Math.min(percent, 100)) : 0
  const status = batch?.status ?? 'idle'
  const remaining = batch ? Math.max(0, batch.total - batch.current) : null
  const activeHere = running || paused
  const blockedByOtherBatch = anyBatchActive && !activeHere
  const taskNoun = scope === 'actress' ? '演员' : '影片'
  const progressCount = batch ? `${batch.current}/${batch.total}` : '未开始'
  const progressCaption = hasBatch ? '完成率' : '待开始'
  const currentDetail = batch?.currentCode
    ? `当前：${batch.currentCode}`
    : hasBatch
      ? batchStatusLabel(status)
      : `等待配置${taskNoun}任务范围`
  const actionHint = blockedByOtherBatch
    ? '已有其他批量任务运行'
    : activeHere
      ? '可暂停、继续或终止当前任务'
      : '选择范围与字段后开始任务'

  return (
    <div
      className={`settings-card settings-card--batch batch-status-${status}${
        expandBatchCard ? ' is-expanded' : ''
      }`}
    >
      <div className="batch-panel-head">
        <div className="batch-panel-head-main">
          <SettingsTabBar
            group="batch"
            tabs={BATCH_TABS}
            activeTab={scope}
            label="批量任务类型"
            className="settings-tab-bar--compact batch-scope-switch"
            onSelect={(tab) => onScopeChange(tab as BatchScope)}
            onKeyDown={onTabKeyDown}
          />
          <div className="batch-title-copy">
            <h3>{title}</h3>
            <div className="hint">{hint}</div>
          </div>
        </div>
        <SettingsStatusPill status={batch?.status ?? 'idle'}>
          {batch ? batchStatusLabel(batch.status) : '空闲'}
        </SettingsStatusPill>
      </div>

      <div className="batch-console">
        <section className="batch-console-main" aria-label={`${title}状态`}>
          <aside className="batch-command-panel" aria-label={`${title}操作`}>
            <div className="batch-command-head">
              <span>任务操作</span>
              <small>{actionHint}</small>
            </div>
            <div className="batch-action-row batch-action-row--compact">
              <button
                className="btn btn-sm btn-primary"
                onClick={onConfigure}
                disabled={anyBatchActive}
              >
                <Settings2 {...UI_ICON_SM} aria-hidden />
                配置并开始
              </button>
              <button className="btn btn-sm" onClick={onPause} disabled={!running}>
                <Pause {...UI_ICON_SM} aria-hidden />
                暂停
              </button>
              <button className="btn btn-sm" onClick={onResume} disabled={!paused}>
                <Play {...UI_ICON_SM} aria-hidden />
                继续
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={onDiscard}
                disabled={!running && !paused}
              >
                <Square {...UI_ICON_SM} aria-hidden />
                终止
              </button>
            </div>
          </aside>

          <div className="batch-run-summary" aria-label={`进度 ${percentLabel}`}>
            <div className="batch-run-overview">
              <div className="batch-run-head">
                <span>运行概览</span>
              </div>
              <div className="batch-run-copy">
                <span>执行进度</span>
                <strong>{progressCount}</strong>
                <small>{currentDetail}</small>
              </div>
            </div>
            <div className="batch-run-metrics">
              <div
                className="batch-progress-dial"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={safePercent}
                style={{ '--batch-pct': percentLabel } as CSSProperties}
              >
                <div className="batch-progress-dial-core">
                  <strong>{percentLabel}</strong>
                  <small>{progressCaption}</small>
                </div>
              </div>
              <div className="batch-run-stats">
                <div>
                  <span>成功</span>
                  <strong className="text-success">{batch?.success ?? 0}</strong>
                </div>
                <div>
                  <span>失败</span>
                  <strong className="text-danger">{batch?.failed ?? 0}</strong>
                </div>
                <div>
                  <span>剩余</span>
                  <strong>{remaining ?? '-'}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="batch-log-panel" aria-label={`${title}日志`}>
          <div className="batch-log-head">
            <span>执行日志</span>
            <small>{batch?.logs.length ?? 0} 条</small>
          </div>
          {batch?.logs.length ? (
            <div className="log-box log-box--batch copyable-text" ref={logRef}>
              {batch.logs.map((line, index) => (
                <div key={index} className={`log-line ${line.level}`}>
                  [{new Date(line.time).toLocaleTimeString()}] {line.code !== '-' ? `${line.code} ` : ''}
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
    </div>
  )
}
