import { useMemo, type ReactNode } from 'react'
import {
  Brain,
  Bot,
  Clapperboard,
  FolderOpen,
  Globe,
  HardDrive,
  Palette,
  Play,
  SlidersHorizontal,
  SquareTerminal,
  UserRound
} from 'lucide-react'
import type {
  AppSettings,
  BatchProgress,
  ThemeId
} from '@shared/types'
import {
  findLlmProviderViewModel,
  listModelsForProvider,
  normalizeDefaultLlmSelection
} from '@shared/llmProviders'
import { UI_ICON_SM } from '../iconDefaults'
import { useToast } from '../Toast'
import { useLibraryOverviewStats } from '../../hooks/useLibraryOverviewStats'
import type { SettingsGroup, SettingsTab } from '../../settings/settingsRoutes'
import { batchStatusLabel, formatCompactPath } from '../../settings/settingsDisplay'
import IconButton from '../IconButton'
import BatchTaskControls, { type BatchControlHandler } from './BatchTaskControls'

export type SettingsOverviewNotice = {
  tone: 'warning' | 'info'
  title: string
  body: string
  action?: () => void
  actionLabel?: string
  actionPrimary?: boolean
}

export type SettingsOverviewAgentToolId = 'plugin-dev'

type SettingsOverviewAgentTool = {
  id: SettingsOverviewAgentToolId
  title: string
  description: string
  icon: typeof Bot
}

function scrapeActionBlockReason(input: {
  anyBatchActive: boolean
  statsLoading: boolean
  defaultScraper?: string | null
  unscraped?: number
  requireUnscraped?: boolean
  requireDefaultScraper?: boolean
  scopeLabel: string
}): string | null {
  if (input.statsLoading) return '统计加载中，请稍后再试'
  if (input.anyBatchActive) return '已有批量任务在运行，请先完成或终止后再启动'
  if (input.requireDefaultScraper && !input.defaultScraper) {
    return `请先设置默认${input.scopeLabel}刮削插件`
  }
  if (input.requireUnscraped && (input.unscraped ?? 0) <= 0) {
    return `当前没有未刮削的${input.scopeLabel}`
  }
  return null
}

const SETTINGS_OVERVIEW_AGENT_TOOLS: SettingsOverviewAgentTool[] = [
  {
    id: 'plugin-dev',
    title: '刮削插件开发助手',
    description: '用 Agent 编写、调试与验证影片 / 演员刮削插件',
    icon: Bot
  }
]

interface SettingsOverviewPanelProps {
  settings: AppSettings
  theme: ThemeId
  themeLabel: string
  notices: SettingsOverviewNotice[]
  videoPluginCount: number
  actressPluginCount: number
  videoBatch: BatchProgress | null
  actressBatch: BatchProgress | null
  anyBatchActive: boolean
  videoBatchPct: number
  actressPct: number
  unrecognizedCount: number
  statsRefreshKey?: number
  onNavigate: (group: SettingsGroup, tab?: SettingsTab) => void
  onNavigateLibraryUnrecognized: () => void
  onOpenAgentTool: (toolId: SettingsOverviewAgentToolId) => void
  onStartVideoBatchDefault: () => void
  onStartActressBatchDefault: () => void
  onOpenVideoBatchAdvanced: () => void
  onOpenActressBatchAdvanced: () => void
  onOpenVideoBatchDetails: () => void
  onOpenActressBatchDetails: () => void
  onPauseVideoBatch: BatchControlHandler
  onPauseActressBatch: BatchControlHandler
  onResumeBatch: BatchControlHandler
  onDiscardVideoBatch: BatchControlHandler
  onDiscardActressBatch: BatchControlHandler
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function scrapePercent(part: number, total: number): number {
  if (total <= 0) return 0
  return Math.round((part / total) * 100)
}

function proxyStatus(enabled: boolean, url: string): { detail: string; value: string } {
  if (enabled && url.trim()) {
    return { detail: formatCompactPath(url, 48), value: '已启用' }
  }
  if (url.trim()) {
    return { detail: '已填写地址', value: '未启用' }
  }
  return { detail: '未配置地址', value: '直连' }
}

function SettingsStatusCard({
  icon: Icon,
  label,
  value,
  detail,
  detailLines,
  attention = false,
  emphasizeValue = false,
  hint,
  onClick
}: {
  icon: typeof FolderOpen
  label: string
  value: ReactNode
  detail?: ReactNode
  detailLines?: string[]
  attention?: boolean
  emphasizeValue?: boolean
  hint?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={`settings-overview-status-card${
        attention ? ' settings-overview-status-card--attention' : ''
      }${emphasizeValue ? ' settings-overview-status-card--emphasis' : ''}`}
      title={hint}
      onClick={onClick}
    >
      <span className="settings-overview-status-card-icon" aria-hidden>
        <Icon {...UI_ICON_SM} />
      </span>
      <span className="settings-overview-status-card-label">{label}</span>
      <strong
        className={`settings-overview-status-card-value${
          emphasizeValue ? ' settings-overview-status-card-value--plugin' : ''
        }`}
      >
        {value}
      </strong>
      {detailLines && detailLines.length > 0 ? (
        <span className="settings-overview-status-card-detail settings-overview-status-card-detail--stack">
          {detailLines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </span>
      ) : detail ? (
        <span className="settings-overview-status-card-detail">{detail}</span>
      ) : null}
    </button>
  )
}

function ScrapeCoverageBlock({
  scraped,
  unscraped,
  failed = 0,
  total,
  title = '刮削覆盖'
}: {
  scraped: number
  unscraped: number
  failed?: number
  total: number
  title?: string
}): JSX.Element | null {
  if (total <= 0) return null

  const scrapedPct = scrapePercent(scraped, total)
  const unscrapedPct = scrapePercent(unscraped, total)
  const failedPct = scrapePercent(failed, total)
  const summary = `${formatCount(scraped)}/${formatCount(total)} · ${scrapedPct}%${
    failed > 0 ? ` · 失败 ${formatCount(failed)}` : ''
  }`

  return (
    <div className="settings-overview-scrape">
      <div className="settings-overview-scrape-head">
        <span>{title}</span>
        <span className="settings-overview-scrape-summary">{summary}</span>
      </div>
      <div
        className="settings-overview-scrape-bar"
        role="img"
        aria-label={`已刮削 ${scrapedPct}%，未刮削 ${unscrapedPct}%${failed > 0 ? `，失败 ${failedPct}%` : ''}`}
      >
        {scrapedPct > 0 && (
          <span
            className="settings-overview-scrape-segment settings-overview-scrape-segment--scraped"
            style={{ flexGrow: scrapedPct }}
          />
        )}
        {unscrapedPct > 0 && (
          <span
            className="settings-overview-scrape-segment settings-overview-scrape-segment--pending"
            style={{ flexGrow: unscrapedPct }}
          />
        )}
        {failedPct > 0 && (
          <span
            className="settings-overview-scrape-segment settings-overview-scrape-segment--failed"
            style={{ flexGrow: failedPct }}
          />
        )}
      </div>
    </div>
  )
}

function BatchOverviewStatus({
  batch,
  percent,
  scopeLabel,
  onOpen,
  onPause,
  onResume,
  onDiscard
}: {
  batch: BatchProgress | null
  percent: number
  scopeLabel: string
  onOpen: () => void
  onPause: BatchControlHandler
  onResume: BatchControlHandler
  onDiscard: BatchControlHandler
}): JSX.Element {
  const activeBatch = Boolean(batch && batch.status !== 'idle')
  const batchRunning = batch?.status === 'running'
  const batchPaused = batch?.status === 'paused'
  const batchControllable = batchRunning || batchPaused
  const status = activeBatch ? batchStatusLabel(batch?.status) : '空闲'
  const safePercent = activeBatch ? Math.max(0, Math.min(percent, 100)) : 0
  const batchCount = activeBatch ? `${batch?.current ?? 0}/${batch?.total ?? 0}` : ''
  const batchDetail = activeBatch
    ? batch?.currentCode
      ? `当前：${batch.currentCode}`
      : `成功 ${batch?.success ?? 0} · 失败 ${batch?.failed ?? 0}`
    : '上方可启动未刮削项或高级刮削'
  const openLabel = `查看${scopeLabel}批量任务详情`

  return (
    <div
      className={`settings-overview-batch-inline${activeBatch ? ' is-active' : ' is-idle'}`}
    >
      <div className="settings-overview-batch-inline-head">
        <span className="settings-overview-batch-inline-title">
          <span>批量任务</span>
          <strong>{status}</strong>
        </span>
        {batchControllable ? (
          <BatchTaskControls
            scopeLabel={scopeLabel}
            running={batchRunning}
            paused={batchPaused}
            status={batch?.status ?? 'idle'}
            variant="icon"
            showDisabled={false}
            onPause={onPause}
            onResume={onResume}
            onDiscard={onDiscard}
          />
        ) : null}
        {activeBatch ? (
          <IconButton
            className="settings-overview-batch-icon-btn settings-overview-batch-detail-btn"
            icon={<SquareTerminal {...UI_ICON_SM} />}
            label={openLabel}
            onClick={onOpen}
          />
        ) : null}
      </div>
      <div
        className="settings-overview-batch-progress"
        role="img"
        aria-label={activeBatch ? `批量任务${status}，进度 ${safePercent}%` : '批量任务空闲'}
      >
        <span style={{ width: `${safePercent}%` }} />
      </div>
      <div className="settings-overview-batch-meta">
        <small>{batchDetail}</small>
        {activeBatch ? (
          <span className="settings-overview-batch-inline-count">{batchCount}</span>
        ) : null}
      </div>
    </div>
  )
}

export default function SettingsOverviewPanel({
  settings,
  theme,
  themeLabel,
  notices,
  videoPluginCount,
  actressPluginCount,
  videoBatch,
  actressBatch,
  anyBatchActive,
  videoBatchPct,
  actressPct,
  unrecognizedCount,
  statsRefreshKey = 0,
  onNavigate,
  onNavigateLibraryUnrecognized,
  onOpenAgentTool,
  onStartVideoBatchDefault,
  onStartActressBatchDefault,
  onOpenVideoBatchAdvanced,
  onOpenActressBatchAdvanced,
  onOpenVideoBatchDetails,
  onOpenActressBatchDetails,
  onPauseVideoBatch,
  onPauseActressBatch,
  onResumeBatch,
  onDiscardVideoBatch,
  onDiscardActressBatch
}: SettingsOverviewPanelProps): JSX.Element {
  const toast = useToast()
  const { stats, isLoading: statsLoading } = useLibraryOverviewStats(statsRefreshKey)

  const defaultLlmSelection = useMemo(() => normalizeDefaultLlmSelection(settings), [settings])
  const defaultLlmProvider = useMemo(
    () =>
      defaultLlmSelection.providerId
        ? findLlmProviderViewModel(settings, defaultLlmSelection.providerId)
        : null,
    [defaultLlmSelection.providerId, settings]
  )
  const defaultLlmModel = useMemo(() => {
    if (!defaultLlmSelection.providerId) return null
    const models = listModelsForProvider(defaultLlmSelection.providerId, settings.llmCustomModels)
    return models.find((item) => item.id === defaultLlmSelection.modelId) ?? null
  }, [defaultLlmSelection.modelId, defaultLlmSelection.providerId, settings.llmCustomModels])

  const videoTotal = stats?.videos.total ?? 0
  const actressTotal = stats?.actresses.total ?? 0
  const actressFemaleTotal = stats?.actresses.female ?? 0
  const videoScraped = stats?.videos.scraped ?? 0
  const actressScraped = stats?.actresses.scraped ?? 0
  const videoUnscraped = stats?.videos.unscraped ?? 0
  const actressUnscraped = stats?.actresses.unscraped ?? 0
  const mediaAssetsPath = settings.mediaAssetsResolvedPath ?? settings.mediaAssetsPath
  const usingDefaultMediaPath = !settings.mediaAssetsPath.trim()
  const mediaAssetsPathLabel = useMemo(() => {
    if (usingDefaultMediaPath) {
      return '默认路径'
    }
    if (!mediaAssetsPath) {
      return '自定义路径'
    }
    return formatCompactPath(mediaAssetsPath)
  }, [mediaAssetsPath, usingDefaultMediaPath])

  const scrapeProxy = proxyStatus(settings.proxyUrlEnabled, settings.proxyUrl ?? '')
  const llmProxy = proxyStatus(settings.llmProxyUrlEnabled, settings.llmProxyUrl ?? '')

  const videoDefaultBlockReason = scrapeActionBlockReason({
    anyBatchActive,
    statsLoading,
    defaultScraper: settings.defaultScraper,
    unscraped: videoUnscraped,
    requireUnscraped: true,
    requireDefaultScraper: true,
    scopeLabel: '影片'
  })
  const videoAdvancedBlockReason = scrapeActionBlockReason({
    anyBatchActive,
    statsLoading,
    scopeLabel: '影片'
  })
  const actressDefaultBlockReason = scrapeActionBlockReason({
    anyBatchActive,
    statsLoading,
    defaultScraper: settings.defaultActressScraper,
    unscraped: actressUnscraped,
    requireUnscraped: true,
    requireDefaultScraper: true,
    scopeLabel: '演员'
  })
  const actressAdvancedBlockReason = scrapeActionBlockReason({
    anyBatchActive,
    statsLoading,
    scopeLabel: '演员'
  })

  const runOrExplain = (blockReason: string | null, action: () => void): void => {
    if (blockReason) {
      toast.show(blockReason, 'info')
      return
    }
    action()
  }

  return (
    <div className="settings-overview">
      {notices.length > 0 && (
        <div className="settings-notice-list" role="status">
          {notices.map((notice) => (
            <div
              key={notice.title}
              className={`settings-notice settings-notice--${notice.tone}`}
            >
              <div className="settings-notice-copy">
                <strong>{notice.title}</strong>
                <span>{notice.body}</span>
              </div>
              {notice.action && notice.actionLabel && (
                <button
                  type="button"
                  className={`btn btn-sm${notice.actionPrimary ? ' btn-primary' : ''}`}
                  onClick={notice.action}
                >
                  {notice.actionLabel}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <section className="settings-overview-panel settings-overview-panel--status" aria-label="状态">
        <h3>状态</h3>
        <div className="settings-overview-status-grid">
          <SettingsStatusCard
            icon={FolderOpen}
            label="媒体库"
            value={`${settings.libraryPaths.length} 个路径`}
            detail={
              statsLoading
                ? '统计加载中…'
                : settings.libraryPaths.length > 0
                  ? `${formatCount(videoTotal)} 部影片`
                  : '点击添加文件夹'
            }
            attention={settings.libraryPaths.length === 0}
            onClick={() => onNavigate('library')}
          />
          {unrecognizedCount > 0 && (
            <SettingsStatusCard
              icon={FolderOpen}
              label="无法识别"
              value={`${unrecognizedCount} 个文件`}
              detail="需手动填写番号"
              attention
              onClick={onNavigateLibraryUnrecognized}
            />
          )}
          <SettingsStatusCard
            icon={Clapperboard}
            label="影片刮削"
            value={settings.defaultScraper || '未设置'}
            detail={`${videoPluginCount} 个插件`}
            emphasizeValue
            attention={!settings.defaultScraper}
            onClick={() => onNavigate('plugins')}
          />
          <SettingsStatusCard
            icon={UserRound}
            label="演员刮削"
            value={settings.defaultActressScraper || '未设置'}
            detail={`${actressPluginCount} 个插件`}
            emphasizeValue
            attention={!settings.defaultActressScraper}
            onClick={() => onNavigate('plugins')}
          />
          <SettingsStatusCard
            icon={Globe}
            label="刮削代理"
            value={scrapeProxy.value}
            detail={scrapeProxy.detail}
            onClick={() => onNavigate('network')}
          />
          <SettingsStatusCard
            icon={Bot}
            label="模型代理"
            value={llmProxy.value}
            detail={llmProxy.detail}
            onClick={() => onNavigate('network')}
          />
          <SettingsStatusCard
            icon={Brain}
            label="默认 LLM"
            value={defaultLlmProvider?.name ?? '未配置'}
            detail={
              defaultLlmProvider
                ? defaultLlmModel?.name ?? defaultLlmSelection.modelId ?? '未选择模型'
                : '未配置供应商'
            }
            emphasizeValue
            attention={!defaultLlmProvider || defaultLlmProvider.status !== 'ready'}
            onClick={() => onNavigate('models')}
          />
          <SettingsStatusCard
            icon={Palette}
            label="外观"
            value={
              <span
                className={`theme-swatch theme-swatch-${theme} settings-overview-status-card-theme-swatch`}
                aria-hidden
              />
            }
            detail={themeLabel}
            onClick={() => onNavigate('appearance')}
          />
          <SettingsStatusCard
            icon={HardDrive}
            label="存储"
            value={settings.assetEncryption ? '加密' : '明文'}
            detail={mediaAssetsPathLabel}
            hint={mediaAssetsPath || undefined}
            onClick={() => onNavigate('storage')}
          />
        </div>
      </section>

      <div className="settings-overview-media-grid">
        <section className="settings-overview-media-card" aria-label="影片刮削概览">
          <div className="settings-overview-hero-head">
            <h3>影片刮削概览</h3>
          </div>

          <ScrapeCoverageBlock
            scraped={videoScraped}
            unscraped={stats?.videos.unscraped ?? 0}
            failed={stats?.videos.failed ?? 0}
            total={videoTotal}
          />

          {videoTotal === 0 && !statsLoading ? (
            <p className="settings-overview-media-empty">添加路径并扫描后开始积累影片</p>
          ) : null}

          <div className="settings-overview-media-action">
            <div className="settings-overview-action-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                aria-disabled={videoDefaultBlockReason ? true : undefined}
                title={videoDefaultBlockReason ?? undefined}
                onClick={() => runOrExplain(videoDefaultBlockReason, onStartVideoBatchDefault)}
              >
                <Play {...UI_ICON_SM} aria-hidden />
                刮削未刮削项
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={videoAdvancedBlockReason ? true : undefined}
                title={videoAdvancedBlockReason ?? undefined}
                onClick={() => runOrExplain(videoAdvancedBlockReason, onOpenVideoBatchAdvanced)}
              >
                <SlidersHorizontal {...UI_ICON_SM} aria-hidden />
                高级刮削
              </button>
            </div>
            <small>
              {settings.defaultScraper || '未设置插件'} · 未刮削项 · 空字段补齐 · 全字段
            </small>
          </div>

          <BatchOverviewStatus
            batch={videoBatch}
            percent={videoBatchPct}
            scopeLabel="影片"
            onOpen={onOpenVideoBatchDetails}
            onPause={onPauseVideoBatch}
            onResume={onResumeBatch}
            onDiscard={onDiscardVideoBatch}
          />
        </section>

        <section className="settings-overview-media-card" aria-label="演员刮削概览">
          <div className="settings-overview-hero-head">
            <h3>演员刮削概览</h3>
          </div>

          <ScrapeCoverageBlock
            scraped={actressScraped}
            unscraped={stats?.actresses.unscraped ?? 0}
            total={actressFemaleTotal}
            title="刮削覆盖 · 女优"
          />

          {actressFemaleTotal === 0 && !statsLoading ? (
            <p className="settings-overview-media-empty">导入影片后会自动建立演员条目</p>
          ) : null}

          <div className="settings-overview-media-action">
            <div className="settings-overview-action-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                aria-disabled={actressDefaultBlockReason ? true : undefined}
                title={actressDefaultBlockReason ?? undefined}
                onClick={() => runOrExplain(actressDefaultBlockReason, onStartActressBatchDefault)}
              >
                <Play {...UI_ICON_SM} aria-hidden />
                刮削未刮削项
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-disabled={actressAdvancedBlockReason ? true : undefined}
                title={actressAdvancedBlockReason ?? undefined}
                onClick={() => runOrExplain(actressAdvancedBlockReason, onOpenActressBatchAdvanced)}
              >
                <SlidersHorizontal {...UI_ICON_SM} aria-hidden />
                高级刮削
              </button>
            </div>
            <small>
              {settings.defaultActressScraper || '未设置插件'} · 女优未刮削项 · 空字段补齐 · 全字段
            </small>
          </div>

          <BatchOverviewStatus
            batch={actressBatch}
            percent={actressPct}
            scopeLabel="演员"
            onOpen={onOpenActressBatchDetails}
            onPause={onPauseActressBatch}
            onResume={onResumeBatch}
            onDiscard={onDiscardActressBatch}
          />
        </section>
      </div>

      <section className="settings-overview-panel settings-overview-panel--agent-tools" aria-label="Agent 工具">
        <h3>Agent 工具</h3>
        <div className="settings-overview-agent-tools-grid">
          {SETTINGS_OVERVIEW_AGENT_TOOLS.map((tool) => {
            const Icon = tool.icon
            return (
              <button
                key={tool.id}
                type="button"
                className="settings-overview-agent-tool-card"
                onClick={() => onOpenAgentTool(tool.id)}
              >
                <span className="settings-overview-agent-tool-icon" aria-hidden>
                  <Icon {...UI_ICON_SM} />
                </span>
                <span className="settings-overview-agent-tool-copy">
                  <strong>{tool.title}</strong>
                  <small>{tool.description}</small>
                </span>
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
