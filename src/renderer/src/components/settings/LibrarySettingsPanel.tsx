import type { RefObject } from 'react'
import { FolderPlus, X } from 'lucide-react'
import type { AppSettings, ScanResult } from '@shared/types'
import { UI_ICON_SM } from '../iconDefaults'
import { SettingsCard, SettingsEmptyPanel, SettingsSectionBlock } from './SettingsPrimitives'
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

  return (
    <SettingsCard className="library-page">
      <SettingsSectionBlock
        title="扫描路径"
        hint="添加文件夹后递归扫描视频文件"
        actions={
          <button type="button" className="btn btn-sm" onClick={onAddFolders}>
            <FolderPlus {...UI_ICON_SM} aria-hidden />
            添加
          </button>
        }
      >
        <div className="media-path-list">
          {settings.libraryPaths.length === 0 ? (
            <SettingsEmptyPanel variant="dashed" className="media-path-empty">
              尚未配置路径
            </SettingsEmptyPanel>
          ) : (
            settings.libraryPaths.map((path) => (
              <div className="path-row" key={path}>
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
      </SettingsSectionBlock>

      <section className="library-scan-panel settings-section-divider" aria-label="扫描导入">
        <div className="library-scan-panel-head">
          <div className="settings-section-block-copy">
            <span className="settings-section-block-title">扫描导入</span>
            <span className="settings-section-block-hint">
              导入新影片、同步路径变动并清理失效记录
            </span>
          </div>
        </div>

        <div className="library-scan-controls">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!scanning && !canScan}
            onClick={scanning ? onCancelScan : onRunScan}
          >
            {scanning ? '取消扫描' : '扫描并导入'}
          </button>

          <label className="library-scan-duration">
            <span className="library-scan-duration-label">最短时长</span>
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

          {scanStatus ? <span className="library-scan-status">{scanStatus}</span> : null}
        </div>

        {minDuration > 0 ? (
          <p className="library-scan-note">
            自动跳过不足 {minDuration} 分钟的文件；设为 0 关闭过滤
          </p>
        ) : (
          <p className="library-scan-note">未启用时长过滤</p>
        )}

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
        ) : null}
      </section>

      {unrecognized.length > 0 ? (
        <SettingsSectionBlock
          id="library-unrecognized"
          blockRef={unrecognizedRef}
          className="settings-section-divider library-unrec-block"
          title={
            <>
              无法识别
              <em>{unrecognized.length}</em>
            </>
          }
          hint="填写番号导入，或展开重命名后重新识别"
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
