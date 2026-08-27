import { useEffect, useRef, useState, type RefObject } from 'react'
import { AlertTriangle, Clock, FolderOpen, FolderPlus, Play, Square, X } from 'lucide-react'
import {
  AUTO_SCAN_INTERVAL_MINUTES,
  type AppSettings,
  type AutoScanIntervalMinutes,
  type SettingsSnapshot
} from '@shared/settingsTypes'
import type {
  LibraryScanAudit,
  LibraryScanMetricKey,
  LibraryScanSummary,
  ScanResult
} from '@shared/libraryTypes'
import { UI_ICON_SM } from '../iconDefaults'
import SettingsSwitchRow from '../SettingsSwitchRow'
import {
  SettingsCard,
  SettingsEmptyPanel,
  SettingsNumberStepper,
  SettingsSectionBlock,
  SettingsStatusPill
} from './SettingsPrimitives'
import LibraryScanAuditPanel from './LibraryScanAuditPanel'
import ListMaintenanceBanner from '../ListMaintenanceBanner'
import Button from '../Button'
import SelectControl from '../SelectControl'
import { api } from '../../api'

const SCAN_TRIGGER_LABEL: Record<LibraryScanSummary['trigger'], string> = {
  manual: '手动',
  startup: '启动后',
  interval: '定时',
  resume: '唤醒后'
}

const SCAN_STATUS_LABEL: Record<LibraryScanSummary['status'], string> = {
  success: '成功',
  completed_with_errors: '完成但有失败项',
  cancelled: '已取消',
  failed: '失败'
}

function formatScanTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function ScanSummary({
  summary,
  audit,
  selected,
  unrecognized,
  currentPendingGroupIds,
  onSelect,
  onResolvedUnrecognized,
  onOpenPending,
  onOpenVideo,
  unrecognizedRef
}: {
  summary: LibraryScanSummary
  audit: LibraryScanAudit | null
  selected: LibraryScanMetricKey | null
  unrecognized: string[]
  currentPendingGroupIds: Set<number>
  onSelect: (key: LibraryScanMetricKey | null) => void
  onResolvedUnrecognized: (path: string) => void
  onOpenPending: (groupId?: number) => void
  onOpenVideo: (videoId: number) => void
  unrecognizedRef: RefObject<HTMLDivElement>
}): JSX.Element {
  return (
    <div className="library-scan-summary" ref={unrecognizedRef}>
      <div className="library-scan-summary-head">
        <div>
          <strong>{SCAN_TRIGGER_LABEL[summary.trigger]}扫描</strong>
          <span>
            {formatScanTime(summary.startedAt)} 至 {formatScanTime(summary.finishedAt)}
          </span>
        </div>
        <SettingsStatusPill
          status={
            summary.status === 'failed' || summary.status === 'completed_with_errors'
              ? 'warning'
              : summary.status
          }
        >
          {SCAN_STATUS_LABEL[summary.status]}
        </SettingsStatusPill>
      </div>
      <LibraryScanAuditPanel
        summary={summary}
        audit={audit}
        selected={selected}
        unrecognized={unrecognized}
        currentPendingGroupIds={currentPendingGroupIds}
        onSelect={onSelect}
        onResolvedUnrecognized={onResolvedUnrecognized}
        onOpenPending={onOpenPending}
        onOpenVideo={onOpenVideo}
      />
      {summary.offlineFolders.length > 0 ? (
        <div className="library-scan-summary-detail is-warning">
          <strong>{summary.offlineFolders.length} 个离线目录</strong>
          {summary.offlineFolders.map((folder) => (
            <div className="library-scan-path-detail" key={folder}>
              <span className="copyable-text" title={folder}>
                {folder}
              </span>
              <Button
                type="button"
                size="sm"
                onClick={() => void navigator.clipboard.writeText(folder)}
              >
                复制路径
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void api.scan.revealAuditFile(folder)}
              >
                在文件夹中显示
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {(summary.strmFailures?.length ?? 0) > 0 || (summary.omittedStrmFailures ?? 0) > 0 ? (
        <div className="library-scan-summary-detail is-warning">
          <strong>STRM 失败项</strong>
          {summary.strmFailures?.map((failure) => (
            <span className="copyable-text" key={`${failure.sourcePath}:${failure.code}`}>
              {failure.sourcePath} · {failure.message}
            </span>
          ))}
          {(summary.omittedStrmFailures ?? 0) > 0 ? (
            <span>另有 {summary.omittedStrmFailures} 项未显示</span>
          ) : null}
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
  scanAudit,
  pendingScanGroupIds,
  focusUnrecognized,
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
  onStartScanScrapeBatch,
  onOpenPending,
  onOpenVideo
}: {
  settings: SettingsSnapshot
  scanning: boolean
  scanStatus: string
  scanResult: ScanResult | null
  scanAudit: LibraryScanAudit | null
  pendingScanGroupIds: Set<number>
  focusUnrecognized: boolean
  unrecognized: string[]
  unrecognizedRef: RefObject<HTMLDivElement>
  onAddFolders: () => void
  onRunScan: () => void
  onCancelScan: () => void
  onRequestRemovePath: (path: string) => void
  onResolvedUnrecognized: (path: string) => void
  onPatchSettings: (
    patch: Partial<
      Pick<
        AppSettings,
        | 'minScanImportDurationMinutes'
        | 'autoMergeSameCodeResources'
        | 'autoDeleteResourceLessVideos'
        | 'autoScanEnabled'
        | 'autoScanIntervalMinutes'
      >
    >
  ) => void
  scanScrapePrompt?: { imported: number; unscraped: number } | null
  videoBatchActive?: boolean
  defaultScraper?: string
  onDismissScanScrapePrompt?: () => void
  onStartScanScrapeBatch?: () => void
  onOpenPending: (groupId?: number) => void
  onOpenVideo: (videoId: number) => void
}): JSX.Element {
  const [selectedMetric, setSelectedMetric] = useState<LibraryScanMetricKey | null>(() => {
    const stored = sessionStorage.getItem('library.scan.selectedMetric')
    return stored as LibraryScanMetricKey | null
  })
  const didAutoSelectUnrecognized = useRef(false)

  useEffect(() => {
    if (unrecognized.length === 0) {
      didAutoSelectUnrecognized.current = false
      return
    }
    if (didAutoSelectUnrecognized.current) return
    didAutoSelectUnrecognized.current = true
    setSelectedMetric('failedFiles')
    sessionStorage.setItem('library.scan.selectedMetric', 'failedFiles')
  }, [unrecognized.length])

  useEffect(() => {
    if (focusUnrecognized) {
      setSelectedMetric('failedFiles')
      sessionStorage.setItem('library.scan.selectedMetric', 'failedFiles')
    }
  }, [focusUnrecognized])

  const selectMetric = (key: LibraryScanMetricKey | null): void => {
    setSelectedMetric(key)
    if (key) sessionStorage.setItem('library.scan.selectedMetric', key)
    else sessionStorage.removeItem('library.scan.selectedMetric')
  }
  const minDuration = settings.minScanImportDurationMinutes
  const canScan = settings.libraryPaths.length > 0
  const pathCount = settings.libraryPaths.length
  const pendingCleanupCount = settings.pendingLibraryPathCleanups.length
  const canScanOrCleanup = canScan || pendingCleanupCount > 0
  const scanStrmFailureCount = scanResult
    ? scanResult.strmFailures.length + scanResult.omittedStrmFailures
    : 0
  const scanHasBlockingFailures = Boolean(
    scanResult &&
      scanResult.failed - scanResult.unrecognizedFiles.length - scanStrmFailureCount > 0
  )
  const scanHasIsolatedFailures = scanStrmFailureCount > 0
  const scanStateLabel = scanning
    ? '扫描中'
    : scanResult
      ? scanHasBlockingFailures
        ? '失败'
        : scanHasIsolatedFailures
          ? '完成但有失败项'
          : '已完成'
      : '待扫描'
  const scanStateTone = scanning
    ? 'running'
    : scanResult
      ? scanHasBlockingFailures || scanHasIsolatedFailures
        ? 'warning'
        : 'success'
      : 'muted'

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
            <button
              type="button"
              className="library-status-action"
              onClick={() => {
                selectMetric('failedFiles')
                window.setTimeout(
                  () => unrecognizedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                  0
                )
              }}
            >
              <SettingsStatusPill status="warning">{unrecognized.length} 个待处理</SettingsStatusPill>
            </button>
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
                <p>递归扫描已添加文件夹中的视频文件与 STRM 链接资源。</p>
              </div>
            </div>
            <Button type="button" size="sm" onClick={onAddFolders}>
              <FolderPlus {...UI_ICON_SM} aria-hidden />
              添加路径
            </Button>
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
          </div>

          <div className="library-scan-command-row">
            <Button
              type="button"
              variant={scanning ? 'default' : 'primary'}
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
            </Button>

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
                ? `自动跳过不足 ${minDuration} 分钟的本地视频；STRM 不受时长过滤影响`
                : '未启用本地视频时长过滤；STRM 始终参与扫描'}
            </span>
            {scanStatus ? <span className="library-scan-status">{scanStatus}</span> : null}
          </div>

          <section className="library-scan-history" aria-labelledby="library-last-scan-title">
            <div className="library-scan-history-head">
              <h5 id="library-last-scan-title">最近一次扫描</h5>
              <span>只保留最近一次手动或后台扫描的审计摘要。</span>
            </div>
            {settings.lastLibraryScanSummary ? (
              <ScanSummary
                summary={settings.lastLibraryScanSummary}
                audit={scanAudit}
                selected={selectedMetric}
                unrecognized={unrecognized}
                currentPendingGroupIds={pendingScanGroupIds}
                onSelect={selectMetric}
                onResolvedUnrecognized={onResolvedUnrecognized}
                onOpenPending={onOpenPending}
                onOpenVideo={onOpenVideo}
                unrecognizedRef={unrecognizedRef}
              />
            ) : (
              <SettingsEmptyPanel variant="compact">尚无扫描记录</SettingsEmptyPanel>
            )}
          </section>

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
        className="library-resource-grouping-block"
        title="资源归属"
        hint="只影响之后扫描发现的新资源；不会自动处理已有待确认组。"
      >
        <div className="settings-toggle-list settings-toggle-list--compact">
          <SettingsSwitchRow
            title="自动归并同番号资源"
            description="扫描时，若番号只对应一部影片，新资源将自动归入该影片；存在多部同番号影片时进入待确认。"
            checked={settings.autoMergeSameCodeResources}
            disabled={scanning}
            onChange={(checked) => onPatchSettings({ autoMergeSameCodeResources: checked })}
          />
        </div>
      </SettingsSectionBlock>

      <SettingsSectionBlock
        className="library-auto-scan-block"
        title="自动扫描"
        hint="应用启动、系统唤醒及运行期间会检查是否已达到扫描间隔。"
      >
        <div className="settings-toggle-list settings-toggle-list--compact">
          <SettingsSwitchRow
            title="按固定间隔自动扫描媒体库"
            description="默认关闭；开启或保存设置后不会立即扫描"
            checked={settings.autoScanEnabled}
            disabled={scanning}
            onChange={(checked) => onPatchSettings({ autoScanEnabled: checked })}
          />
        </div>
        <label className={`library-auto-scan-interval${settings.autoScanEnabled ? '' : ' is-disabled'}`}>
          <span>
            <strong>扫描间隔</strong>
            <small>以上一次扫描完成时间为起点</small>
          </span>
          <SelectControl
            aria-label="自动扫描间隔"
            value={settings.autoScanIntervalMinutes}
            disabled={!settings.autoScanEnabled || scanning}
            onChange={(event) =>
              onPatchSettings({
                autoScanIntervalMinutes: Number(event.target.value) as AutoScanIntervalMinutes
              })
            }
          >
            {AUTO_SCAN_INTERVAL_MINUTES.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}
              </option>
            ))}
          </SelectControl>
        </label>
      </SettingsSectionBlock>

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

    </SettingsCard>
  )
}
