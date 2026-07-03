import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
  UserRound,
} from 'lucide-react'
import type {
  AppSettings,
  BatchProgress,
  LibraryOverviewStats,
  ThemeId
} from '@shared/types'
import {
  findLlmProviderViewModel,
  listModelsForProvider
} from '@shared/llmProviders'
import { api } from '../../api'
import { UI_ICON_SM } from '../iconDefaults'
import type { SettingsGroup, SettingsTab } from '../../settings/settingsRoutes'
import { batchStatusLabel, formatCompactPath } from '../../settings/settingsDisplay'

export type SettingsOverviewNotice = {
  tone: 'warning' | 'info'
  title: string
  body: string
  action?: () => void
  actionLabel?: string
}

export type SettingsOverviewAgentToolId = 'plugin-dev'

type SettingsOverviewAgentTool = {
  id: SettingsOverviewAgentToolId
  title: string
  description: string
  icon: typeof Bot
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
  onOpen
}: {
  batch: BatchProgress | null
  percent: number
  onOpen: () => void
}): JSX.Element {
  const activeBatch = Boolean(batch && batch.status !== 'idle')
  const status = batchStatusLabel(batch?.status)
  const safePercent = activeBatch ? Math.max(0, Math.min(percent, 100)) : 0
  const batchCount = activeBatch ? `${batch?.current ?? 0}/${batch?.total ?? 0}` : '无运行任务'
  const batchDetail = batch?.currentCode
    ? `当前：${batch.currentCode}`
    : batch
      ? `成功 ${batch.success} · 失败 ${batch.failed}`
      : '等待下一次批量刮削'

  return (
    <div
      className={`settings-overview-batch-inline${activeBatch ? ' is-active' : ' is-idle'}`}
    >
      <div className="settings-overview-batch-inline-head">
        <span className="settings-overview-batch-inline-title">
          <span>批量任务</span>
          <strong>{status}</strong>
        </span>
        <span className="settings-overview-batch-inline-count">{batchCount}</span>
        <button type="button" className="btn btn-sm" onClick={onOpen}>
          打开
        </button>
      </div>
      <div
        className="settings-overview-batch-progress"
        role="img"
        aria-label={`批量任务${status}，进度 ${safePercent}%`}
      >
        <span style={{ width: `${safePercent}%` }} />
      </div>
      <small>{batchDetail}</small>
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
  onOpenActressBatchAdvanced
}: SettingsOverviewPanelProps): JSX.Element {
  const [stats, setStats] = useState<LibraryOverviewStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const actressBatchProgressRef = useRef<{ current: number; status: BatchProgress['status'] } | null>(
    null
  )
  const videoBatchProgressRef = useRef<{ current: number; status: BatchProgress['status'] } | null>(
    null
  )

  const loadStats = useCallback(async (options?: { silent?: boolean }): Promise<void> => {
    if (!options?.silent) setStatsLoading(true)
    try {
      setStats(await api.settings.getOverviewStats())
    } catch {
      setStats(null)
    } finally {
      if (!options?.silent) setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats, statsRefreshKey])

  useEffect(() => {
    if (!actressBatch) return
    const prev = actressBatchProgressRef.current
    const finished =
      prev != null &&
      prev.status !== 'idle' &&
      (actressBatch.status === 'idle' ||
        actressBatch.status === 'done' ||
        actressBatch.status === 'cancelled')
    const advanced =
      actressBatch.status !== 'idle' &&
      (prev?.current !== actressBatch.current || prev?.status !== actressBatch.status)
    actressBatchProgressRef.current = {
      current: actressBatch.current,
      status: actressBatch.status
    }
    if (advanced || finished) void loadStats({ silent: true })
  }, [actressBatch?.current, actressBatch?.status, loadStats])

  useEffect(() => {
    if (!videoBatch) return
    const prev = videoBatchProgressRef.current
    const finished =
      prev != null &&
      prev.status !== 'idle' &&
      (videoBatch.status === 'idle' ||
        videoBatch.status === 'done' ||
        videoBatch.status === 'cancelled')
    const advanced =
      videoBatch.status !== 'idle' &&
      (prev?.current !== videoBatch.current || prev?.status !== videoBatch.status)
    videoBatchProgressRef.current = {
      current: videoBatch.current,
      status: videoBatch.status
    }
    if (advanced || finished) void loadStats({ silent: true })
  }, [videoBatch?.current, videoBatch?.status, loadStats])

  const defaultLlmProvider = useMemo(
    () => findLlmProviderViewModel(settings, settings.defaultLlmProviderId),
    [settings]
  )
  const defaultLlmModel = useMemo(() => {
    const models = listModelsForProvider(settings.defaultLlmProviderId, settings.llmCustomModels)
    return models.find((item) => item.id === settings.defaultLlmModelId)
  }, [settings.defaultLlmModelId, settings.defaultLlmProviderId, settings.llmCustomModels])

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
                <button type="button" className="btn btn-sm" onClick={notice.action}>
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
                ? defaultLlmModel?.name ?? settings.defaultLlmModelId ?? '未选择模型'
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
                disabled={
                  anyBatchActive ||
                  statsLoading ||
                  !settings.defaultScraper ||
                  videoUnscraped === 0
                }
                onClick={onStartVideoBatchDefault}
              >
                <Play {...UI_ICON_SM} aria-hidden />
                刮削未刮削项
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={anyBatchActive || statsLoading}
                onClick={onOpenVideoBatchAdvanced}
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
            onOpen={() => onNavigate('batch', 'video')}
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
                disabled={
                  anyBatchActive ||
                  statsLoading ||
                  !settings.defaultActressScraper ||
                  actressUnscraped === 0
                }
                onClick={onStartActressBatchDefault}
              >
                <Play {...UI_ICON_SM} aria-hidden />
                刮削未刮削项
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={anyBatchActive || statsLoading}
                onClick={onOpenActressBatchAdvanced}
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
            onOpen={() => onNavigate('batch', 'actress')}
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
