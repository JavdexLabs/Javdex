import type { RefObject } from 'react'
import { AlertTriangle, Clock, FolderOpen, FolderPlus, Play, Square, X } from 'lucide-react'
import type { AppSettings, ScanResult } from '@shared/types'
import { UI_ICON_SM } from '../iconDefaults'
import {
  SettingsCard,
  SettingsEmptyPanel,
  SettingsSectionBlock,
  SettingsStatusPill
} from './SettingsPrimitives'
import UnrecognizedRow from './UnrecognizedRow'

type ScanMetric = {
  key: string
  label: string
  value: number
  tone?: 'default' | 'accent' | 'warn'
}

function buildScanMetrics(result: ScanResult): ScanMetric[] {
  const items: ScanMetric[] = [
    { key: 'scanned', label: '扫描', value: result.scannedFiles },
    { key: 'imported', label: '新导入', value: result.imported, tone: 'accent' },
    { key: 'relocated', label: '路径更新', value: result.relocated },
    { key: 'removed', label: '移除', value: result.removed },
    { key: 'skipped', label: '跳过', value: result.skipped }
  ]
  if (result.skippedShort > 0) {
    items.push({ key: 'skippedShort', label: '过短', value: result.skippedShort })
  }
  if (result.failed > 0) {
    items.push({ key: 'failed', label: '无法识别', value: result.failed, tone: 'warn' })
  }
  return items
}

export default function LibrarySettingsPanel({
  settings,
  scanning,
  scanStatus,
  scanResult,
  unrecognized,
  unrecognizedRef,
  onAddFolders,
  onRunScan,
  onCancelScan,
  onRequestRemovePath,
  onResolvedUnrecognized,
  onPatchSettings
}: {
  settings: AppSettings
  scanning: boolean
  scanStatus: string
  scanResult: ScanResult | null
  unrecognized: string[]
  unrecognizedRef: RefObject<HTMLDivElement>
  onAddFolders: () => void
  onRunScan: () => void
  onCancelScan: () => void
  onRequestRemovePath: (path: string) => void
  onResolvedUnrecognized: (path: string) => void
  onPatchSettings: (patch: Partial<Pick<AppSettings, 'minScanImportDurationMinutes'>>) => void
}): JSX.Element {
  const minDuration = settings.minScanImportDurationMinutes
  const scanMetrics = scanResult ? buildScanMetrics(scanResult) : null
  const canScan = settings.libraryPaths.length > 0
  const pathCount = settings.libraryPaths.length
  const scanStateLabel = scanning ? '扫描中' : scanResult ? '已完成' : '待扫描'
  const scanStateTone = scanning ? 'running' : scanResult ? 'success' : 'muted'

  return (
    <SettingsCard
      className="library-page"
      title="媒体库导入"
      hint="配置扫描路径，导入新影片，同步文件路径变动，并处理无法识别的文件。"
      actions={
        <div className="library-status-row" aria-live="polite">
          <SettingsStatusPill status={pathCount > 0 ? 'info' : 'warning'}>
            {pathCount > 0 ? `${pathCount} 个路径` : '未配置路径'}
          </SettingsStatusPill>
          <SettingsStatusPill status={scanStateTone}>{scanStateLabel}</SettingsStatusPill>
          {unrecognized.length > 0 ? (
            <SettingsStatusPill status="warning">{unrecognized.length} 个待处理</SettingsStatusPill>
          ) : null}
        </div>
      }
    >
      <div className="library-settings-grid">
        <section className="library-path-panel" aria-label="扫描路径">
          <div className="library-panel-head">
            <div className="library-panel-title">
              <span className="library-panel-icon" aria-hidden="true">
                <FolderOpen {...UI_ICON_SM} />
              </span>
              <div>
                <h4>扫描路径</h4>
                <p>递归扫描已添加文件夹中的视频文件。</p>
              </div>
            </div>
            <button type="button" className="btn btn-sm" onClick={onAddFolders}>
              <FolderPlus {...UI_ICON_SM} aria-hidden />
              添加路径
            </button>
          </div>

          <div className="media-path-list library-path-list">
            {pathCount === 0 ? (
              <SettingsEmptyPanel variant="dashed" className="media-path-empty library-path-empty">
                尚未配置扫描路径
              </SettingsEmptyPanel>
            ) : (
              settings.libraryPaths.map((path) => (
                <div className="path-row library-path-row" key={path}>
                  <FolderOpen {...UI_ICON_SM} aria-hidden />
                  <span className="path-row-text" title={path}>
                    {path}
                  </span>
                  <button
                    type="button"
                    className="path-row-remove"
                    aria-label={`移除路径 ${path}`}
                    onClick={() => onRequestRemovePath(path)}
                  >
                    <X {...UI_ICON_SM} />
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className={`library-scan-console${scanning ? ' is-scanning' : ''}`} aria-label="扫描导入">
          <div className="library-panel-head">
            <div className="library-panel-title">
              <span className="library-panel-icon" aria-hidden="true">
                {scanning ? <Square {...UI_ICON_SM} /> : <Play {...UI_ICON_SM} />}
              </span>
              <div>
                <h4>扫描导入</h4>
                <p>导入新影片、同步路径变动并清理失效记录。</p>
              </div>
            </div>
            <SettingsStatusPill status={scanStateTone}>{scanStateLabel}</SettingsStatusPill>
          </div>

          <div className="library-scan-command-row">
            <button
              type="button"
              className={`btn ${scanning ? '' : 'btn-primary'}`}
              disabled={!scanning && !canScan}
              onClick={scanning ? onCancelScan : onRunScan}
            >
              {scanning ? (
                <>
                  <Square {...UI_ICON_SM} aria-hidden />
                  取消扫描
                </>
              ) : (
                <>
                  <Play {...UI_ICON_SM} aria-hidden />
                  扫描并导入
                </>
              )}
            </button>

            <label className="library-scan-duration">
              <span className="library-scan-duration-label">
                <Clock {...UI_ICON_SM} aria-hidden />
                最短时长
              </span>
              <input
                className="text-input library-scan-duration-input"
                type="number"
                min={0}
                max={600}
                step={1}
                inputMode="numeric"
                disabled={scanning}
                value={minDuration}
                onChange={(e) => {
                  const parsed = Number(e.target.value)
                  if (!Number.isFinite(parsed)) return
                  onPatchSettings({ minScanImportDurationMinutes: parsed })
                }}
              />
              <span className="library-scan-duration-unit">分钟</span>
            </label>
          </div>

          <div className="library-scan-message-row">
            <span className="library-scan-note">
              {minDuration > 0
                ? `自动跳过不足 ${minDuration} 分钟的文件`
                : '未启用时长过滤'}
            </span>
            {scanStatus ? <span className="library-scan-status">{scanStatus}</span> : null}
          </div>

          {scanMetrics ? (
            <div className="library-scan-metrics" aria-live="polite">
              {scanMetrics.map((item) => (
                <div
                  key={item.key}
                  className={`library-scan-metric${item.tone ? ` library-scan-metric--${item.tone}` : ''}`}
                >
                  <span className="library-scan-metric-value">{item.value}</span>
                  <span className="library-scan-metric-label">{item.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="library-scan-placeholder">
              <span>扫描完成后显示导入、跳过和无法识别统计。</span>
            </div>
          )}
        </section>
      </div>

      {unrecognized.length > 0 ? (
        <SettingsSectionBlock
          id="library-unrecognized"
          blockRef={unrecognizedRef}
          className="library-unrec-block"
          title={
            <>
              无法识别
              <em>{unrecognized.length}</em>
            </>
          }
          hint="手工填写番号导入，或重命名文件后重新识别。"
          actions={
            <SettingsStatusPill status="warning">
              <AlertTriangle {...UI_ICON_SM} aria-hidden />
              待处理
            </SettingsStatusPill>
          }
        >
          <div className="scan-unrec-list">
            {unrecognized.map((path) => (
              <UnrecognizedRow key={path} path={path} onResolved={onResolvedUnrecognized} />
            ))}
          </div>
        </SettingsSectionBlock>
      ) : null}
    </SettingsCard>
  )
}
