import type { RefObject } from 'react'
import { AlertTriangle, Clock, FolderOpen, FolderPlus, Play, Square, X } from 'lucide-react'
import type { AppSettings } from '@shared/settingsTypes'
import type { LibraryScanSummary, ScanResult } from '@shared/libraryTypes'
import { UI_ICON_SM } from '../iconDefaults'
import SettingsSwitchRow from '../SettingsSwitchRow'
import {
  SettingsCard,
  SettingsEmptyPanel,
  SettingsNumberStepper,
  SettingsSectionBlock,
  SettingsStatusPill
} from './SettingsPrimitives'
import UnrecognizedRow from './UnrecognizedRow'
import ListMaintenanceBanner from '../ListMaintenanceBanner'

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
    { key: 'relocated', label: '更新资源', value: result.relocated },
    { key: 'removed', label: '移除', value: result.removed },
    { key: 'promoted', label: '提升主资源', value: result.promoted },
    { key: 'deletedVideos', label: '删除影片', value: result.deletedVideos },
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

const SCAN_TRIGGER_LABEL: Record<LibraryScanSummary['trigger'], string> = {
  manual: '手动',
  startup: '启动后',
  interval: '定时',
  resume: '唤醒后'
}

const SCAN_STATUS_LABEL: Record<LibraryScanSummary['status'], string> = {
  success: '成功',
  cancelled: '已取消',
  failed: '失败'
}

function formatScanTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function ScanSummary({ summary }: { summary: LibraryScanSummary }): JSX.Element {
  const metrics = [
    ['新增资源', summary.resourcesAdded],
    ['更新资源', summary.resourcesUpdated],
    ['移除资源', summary.resourcesRemoved],
    ['提升主资源', summary.primaryResourcesPromoted],
    ['删除影片', summary.videosDeleted],
    ['扫描文件', summary.scannedFiles],
    ['跳过文件', summary.skippedFiles],
    ['异常文件', summary.failedFiles]
  ] as const
  return (
    <div className="library-scan-summary">
      <div className="library-scan-summary-head">
        <div>
          <strong>{SCAN_TRIGGER_LABEL[summary.trigger]}扫描</strong>
          <span>{formatScanTime(summary.startedAt)} 至 {formatScanTime(summary.finishedAt)}</span>
        </div>
        <SettingsStatusPill status={summary.status === 'failed' ? 'warning' : summary.status}>
          {SCAN_STATUS_LABEL[summary.status]}
        </SettingsStatusPill>
      </div>
      <div className="library-scan-summary-metrics">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {summary.offlineFolders.length > 0 ? (
        <div className="library-scan-summary-detail is-warning">
          <strong>{summary.offlineFolders.length} 个离线目录</strong>
          {summary.offlineFolders.map((folder) => (
            <span className="copyable-text" key={folder}>{folder}</span>
          ))}
        </div>
      ) : null}
      {summary.errorSummary ? (
        <div className="library-scan-summary-detail is-error">
          <strong>错误摘要</strong>
          <span className="copyable-text">{summary.errorSummary}</span>
        </div>
      ) : null}
    </div>
  )
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
  onPatchSettings,
  scanScrapePrompt,
  videoBatchActive = false,
  defaultScraper = '',
  onDismissScanScrapePrompt,
  onStartScanScrapeBatch
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
  onPatchSettings: (
    patch: Partial<
      Pick<AppSettings, 'minScanImportDurationMinutes' | 'autoDeleteResourceLessVideos'>
    >
  ) => void
  scanScrapePrompt?: { imported: number; unscraped: number } | null
  videoBatchActive?: boolean
  defaultScraper?: string
  onDismissScanScrapePrompt?: () => void
  onStartScanScrapeBatch?: () => void
}): JSX.Element {
  const minDuration = settings.minScanImportDurationMinutes
  const scanMetrics = scanResult ? buildScanMetrics(scanResult) : null
  const canScan = settings.libraryPaths.length > 0
  const pathCount = settings.libraryPaths.length
  const pendingCleanupCount = settings.pendingLibraryPathCleanups.length
  const canScanOrCleanup = canScan || pendingCleanupCount > 0
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
          {pendingCleanupCount > 0 ? (
            <SettingsStatusPill status="warning">{pendingCleanupCount} 个路径待清理</SettingsStatusPill>
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
                    title={scanning ? '扫描期间无法移除路径' : '移除路径'}
                    disabled={scanning}
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
              disabled={!scanning && !canScanOrCleanup}
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
                  {canScan ? '扫描并导入' : '执行待清理'}
                </>
              )}
            </button>

            <div className="library-scan-duration">
              <span className="library-scan-duration-label">
                <Clock {...UI_ICON_SM} aria-hidden />
                最短时长
              </span>
              <SettingsNumberStepper
                aria-label="最短导入时长（分钟）"
                value={minDuration}
                min={0}
                max={600}
                step={1}
                unit="分钟"
                disabled={scanning}
                onChange={(next) => onPatchSettings({ minScanImportDurationMinutes: next })}
              />
            </div>
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

          {scanScrapePrompt && !scanning ? (
            <ListMaintenanceBanner
              className="library-scan-scrape-prompt"
              title={`本次导入 ${scanScrapePrompt.imported} 部，库内仍有 ${scanScrapePrompt.unscraped} 部待刮削`}
              detail="可立即使用默认插件批量补齐元数据与封面。"
              secondaryLabel="稍后"
              primaryLabel={videoBatchActive ? '刮削进行中…' : '一键刮削'}
              onSecondary={() => onDismissScanScrapePrompt?.()}
              onPrimary={() => onStartScanScrapeBatch?.()}
              onDismiss={() => onDismissScanScrapePrompt?.()}
              primaryDisabled={videoBatchActive || !defaultScraper}
              primaryDisabledReason={
                videoBatchActive
                  ? '批量刮削任务进行中'
                  : !defaultScraper
                    ? '请先在插件设置中配置默认影片刮削插件'
                    : undefined
              }
            />
          ) : null}
        </section>
      </div>

      <SettingsSectionBlock
        className="library-safety-block"
        title="扫描后清理"
        hint="只在完整扫描成功且所有目录在线时执行。"
      >
        <div className="settings-toggle-list settings-toggle-list--compact">
          <SettingsSwitchRow
            title="扫描后自动删除无资源影片"
            description="仅按资源记录为零判断；链接可用性不会触发删除"
            checked={settings.autoDeleteResourceLessVideos}
            disabled={scanning}
            onChange={(checked) => onPatchSettings({ autoDeleteResourceLessVideos: checked })}
          />
        </div>
        <div className="settings-notice settings-notice--warning library-destructive-warning">
          <AlertTriangle {...UI_ICON_SM} aria-hidden />
          <div className="settings-notice-copy">
            <strong>不可逆清理</strong>
            <span>
              开启后会删除无资源影片的元数据、标签关系和应用自有图片，且无法恢复；
              不会删除媒体目录中的源文件。扫描失败、取消或存在离线目录时不会执行。
            </span>
          </div>
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock
        className="library-summary-block"
        title="最近一次扫描"
        hint="只保留最近一次手动或后台扫描的审计摘要。"
      >
        {settings.lastLibraryScanSummary ? (
          <ScanSummary summary={settings.lastLibraryScanSummary} />
        ) : (
          <SettingsEmptyPanel variant="compact">尚无扫描记录</SettingsEmptyPanel>
        )}
      </SettingsSectionBlock>

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
