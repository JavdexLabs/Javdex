import type { CSSProperties, KeyboardEventHandler, RefObject } from 'react'
import type { BatchProgress } from '@shared/types'
import { batchStatusLabel } from '../../settings/settingsDisplay'
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

  return (
    <div className={`settings-card settings-card--batch${expandBatchCard ? ' is-expanded' : ''}`}>
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
          <div>
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
          <div className="batch-run-summary" aria-label={`进度 ${percentLabel}`}>
            <div className="batch-run-copy">
              <span>执行进度</span>
              <strong>{batch ? `${batch.current}/${batch.total}` : '未开始'}</strong>
              <small>{batch?.currentCode ? `当前：${batch.currentCode}` : '等待配置任务范围'}</small>
            </div>
            <div
              className="batch-progress-dial"
              style={{ '--batch-pct': percentLabel } as CSSProperties}
            >
              <strong>{percentLabel}</strong>
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
                <strong>{batch ? Math.max(0, batch.total - batch.current) : '-'}</strong>
              </div>
            </div>
          </div>

          <div className="batch-action-row batch-action-row--compact">
            <button className="btn btn-sm btn-primary" onClick={onConfigure} disabled={anyBatchActive}>
              配置并开始
            </button>
            <button className="btn btn-sm" onClick={onPause} disabled={!running}>
              暂停
            </button>
            <button className="btn btn-sm" onClick={onResume} disabled={!paused}>
              继续
            </button>
            <button className="btn btn-sm btn-danger" onClick={onDiscard} disabled={!running && !paused}>
              终止
            </button>
          </div>
        </section>

        <section className="batch-log-panel" aria-label={`${title}日志`}>
          <div className="batch-log-head">
            <span>日志</span>
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
