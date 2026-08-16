import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { ActressBatchScrapeScope, ActressBatchScrapeStatus, ActressScrapeField, ActressScrapeUpdateMode, VideoBatchScrapeStatus, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/scrapeTypes'
import type { AppSettings, SettingsSnapshot } from '@shared/settingsTypes'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import { ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS, ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS, ACTRESS_SCRAPE_FIELD_OPTIONS, ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS, ALL_ACTRESS_SCRAPE_FIELDS, ALL_VIDEO_SCRAPE_FIELDS, VIDEO_BATCH_SCRAPE_STATUS_OPTIONS, VIDEO_SCRAPE_FIELD_OPTIONS, VIDEO_SCRAPE_UPDATE_MODE_OPTIONS } from '@shared/scrapeTypes'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { api } from '../api'
import { actressKeys, overviewStatsKeys } from '../query/queryKeys'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import PluginDevPanel from '../components/pluginDev/PluginDevPanel'
import AppearanceSettingsPanel from '../components/settings/AppearanceSettingsPanel'
import AboutSettingsPanel from '../components/settings/AboutSettingsPanel'
import BatchSettingsPanel from '../components/settings/BatchSettingsPanel'
import LibrarySettingsPanel from '../components/settings/LibrarySettingsPanel'
import ModelSettingsPanel from '../components/settings/ModelSettingsPanel'
import NetworkSettingsPanel from '../components/settings/NetworkSettingsPanel'
import PluginsSettingsPanel from '../components/settings/PluginsSettingsPanel'
import StorageSettingsPanel from '../components/settings/StorageSettingsPanel'
import SettingsOverviewPanel from '../components/settings/SettingsOverviewPanel'
import SettingsWorkspaceShell, {
  SettingsPluginDevShell
} from '../components/settings/SettingsWorkspaceShell'
import {
  CompositeConfigModal,
  PluginConfigModal
} from '../components/settings/PluginConfigModals'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import { useToast } from '../components/Toast'
import { useTheme } from '../components/ThemeProvider'
import { useLibraryOverviewStats } from '../hooks/useLibraryOverviewStats'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import { useAvatarAutoCropBatch } from '../contexts/AvatarAutoCropBatchContext'
import { pendingCenterPath } from '../listView/pendingRoutes'
import useNetworkSettingsController from '../hooks/useNetworkSettingsController'
import useLatestAsyncLabel from '../hooks/useLatestAsyncLabel'
import useScraperPluginSettingsController from '../hooks/useScraperPluginSettingsController'
import useLibrarySettingsController from '../hooks/useLibrarySettingsController'
import {
  resolveSettingsRoute,
  settingsPath,
  settingsPluginDevPath,
  type SettingsGroup,
  type SettingsTab
} from '../settings/settingsRoutes'
import { THEME_OPTIONS } from '../theme'
import type { ThemeId } from '@shared/settingsTypes'
import type { UpdateCheckState } from '@shared/updateTypes'
import Button from '../components/Button'

function shouldAutoScrollBatchLog(container: HTMLDivElement): boolean {
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && selection.anchorNode) {
    if (container.contains(selection.anchorNode)) return false
  }
  const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
  return distanceFromBottom < 48
}

function scrollBatchLogToBottom(ref: RefObject<HTMLDivElement>): void {
  const el = ref.current
  if (!el || !shouldAutoScrollBatchLog(el)) return
  el.scrollTop = el.scrollHeight
}

function summarizeReleaseNotes(notes: string): string {
  const summary = notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*|^[-*]\s*/, '').trim())
    .find(Boolean)
  if (!summary) return '新版本可用，前往关于页面查看更新说明和下载地址。'
  return summary.length > 96 ? `${summary.slice(0, 96)}…` : summary
}

export default function SettingsPage(): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, setTheme, syncPrivacyMode } = useTheme()
  const { group: activeGroup, tab: activeTab } = resolveSettingsRoute(location.pathname)
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null)
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null)
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0)
  const [updateCheckState, setUpdateCheckState] = useState<UpdateCheckState | null>(null)
  const [dismissedRecoveryBackup, setDismissedRecoveryBackup] = useState<string | null>(null)
  const openPluginDev = useCallback(() => navigate(settingsPluginDevPath()), [navigate])
  const {
    scrapers,
    actressScrapers,
    videoPluginDetails,
    actressPluginDetails,
    videoUserPlugins,
    actressUserPlugins,
    videoCompositePlugins,
    actressCompositePlugins,
    pluginBusy,
    editingPlugin,
    setEditingPlugin,
    editingComposite,
    setEditingComposite,
    pluginDeleteTarget,
    setPluginDeleteTarget,
    devLoadPackage,
    clearDevLoadPackage,
    importPlugin,
    exportPlugin,
    loadPluginForAiDebug,
    confirmPluginDelete,
    savePluginConfig,
    saveCompositePlugin,
    changeDefaultPlugin,
    handleInstalled
  } = useScraperPluginSettingsController({
    shouldLoad:
      activeGroup.id === 'overview' ||
      activeGroup.id === 'plugins' ||
      location.pathname === settingsPluginDevPath(),
    openPluginDev,
    setSettings
  })
  const {
    proxySaving,
    proxyTesting,
    proxyToggleBusy,
    setScrapeProxyDraft,
    setLlmProxyDraft,
    toggleScrapeProxyEnabled,
    toggleLlmProxyEnabled,
    saveScrapeProxyUrl,
    saveLlmProxyUrl,
    testScrapeProxy,
    testLlmProxy
  } = useNetworkSettingsController(settings, setSettings)
  const {
    pathRemoval,
    pathRemoveBusy,
    closePathRemoval,
    requestRemovePath,
    confirmRemovePath,
    scanning,
    scanStatus,
    scanResult,
    unrecognized,
    overviewStatsRefreshKey,
    scanScrapePrompt,
    addFolders,
    patchLibrarySettings,
    runScan,
    cancelScan,
    handleResolved,
    dismissScanScrapePrompt
  } = useLibrarySettingsController({ settings, setSettings })
  const {
    videoBatch,
    actressBatch,
    actressBatchRecoverable,
    actressBatchUnrecoverableReason
  } = useBatchScrapeActivity()
  const avatarAutoCropBatch = useAvatarAutoCropBatch()
  const [showVideoBatchModal, setShowVideoBatchModal] = useState(false)
  const [showActressBatchModal, setShowActressBatchModal] = useState(false)
  const [batchDetailScope, setBatchDetailScope] = useState<
    'video' | 'actress' | 'avatar' | null
  >(null)
  const {
    label: videoBatchScopeCountLabel,
    refresh: refreshVideoBatchScopeCount,
    reset: resetVideoBatchScopeCount
  } = useLatestAsyncLabel('- 部影片')
  const {
    label: actressBatchScopeCountLabel,
    refresh: refreshActressBatchScopeCount,
    reset: resetActressBatchScopeCount
  } = useLatestAsyncLabel('- 位演员')
  const [storageBusy, setStorageBusy] = useState(false)
  const { stats: overviewStats } = useLibraryOverviewStats(
    overviewStatsRefreshKey,
    activeGroup.id === 'overview' && location.pathname !== settingsPluginDevPath()
  )
  const actressConflictSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: 3000
  })
  const actressConflictGroupCount = actressConflictSummaryQuery.data?.groupCount ?? 0
  const videoBatchLogRef = useRef<HTMLDivElement>(null)
  const actressLogRef = useRef<HTMLDivElement>(null)
  const avatarBatchLogRef = useRef<HTMLDivElement>(null)
  const libraryUnrecRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (activeGroup.id !== 'overview') return
    void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  }, [activeGroup.id, queryClient])

  const dismissSettingsOverlays = useCallback(() => {
    setEditingPlugin(null)
    setEditingComposite(null)
    setPluginDeleteTarget(null)
    closePathRemoval()
    setShowVideoBatchModal(false)
    setShowActressBatchModal(false)
    setBatchDetailScope(null)
  }, [closePathRemoval, setEditingComposite, setEditingPlugin, setPluginDeleteTarget])

  useDismissOverlaysOnNavigate(dismissSettingsOverlays, location.pathname)

  const libraryFocus = (location.state as { libraryFocus?: string } | null)?.libraryFocus

  useEffect(() => {
    if (activeGroup.id !== 'library' || libraryFocus !== 'unrecognized') return
    const timer = window.setTimeout(() => {
      libraryUnrecRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      navigate(location.pathname, { replace: true, state: {} })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [activeGroup.id, libraryFocus, location.pathname, navigate])

  useEffect(() => {
    let active = true
    setSettingsLoadError(null)
    void api.settings
      .get()
      .then((next) => {
        if (active) {
          setSettings(next)
          setSettingsLoadError(null)
        }
      })
      .catch((error) => {
        if (active) {
          const message = String((error as Error).message ?? error)
          setSettingsLoadError(message)
          toast.show(message, 'error')
        }
      })
    return () => {
      active = false
    }
  }, [settingsLoadAttempt, toast])

  useEffect(() => {
    let active = true
    void api.appUpdate
      .getState()
      .then((state) => {
        if (active) setUpdateCheckState(state)
      })
      .catch((error) => {
        if (active) toast.show(String((error as Error).message ?? error), 'error')
      })
    const unsubscribe = api.appUpdate.onStateChanged(setUpdateCheckState)
    return () => {
      active = false
      unsubscribe()
    }
  }, [toast])

  useEffect(() => {
    scrollBatchLogToBottom(videoBatchLogRef)
  }, [videoBatch?.logs.length])

  useEffect(() => {
    scrollBatchLogToBottom(actressLogRef)
  }, [actressBatch?.logs.length])

  useEffect(() => {
    scrollBatchLogToBottom(avatarBatchLogRef)
  }, [avatarAutoCropBatch.state.logs.length])

  const refreshVideoBatchScopeHint = useCallback(async (
    status: VideoBatchScrapeStatus,
    missingFields: VideoScrapeField[] = [],
    scraperName?: string
  ): Promise<void> => {
    await refreshVideoBatchScopeCount(
      () => api.scrape.videoBatchCount({ status, missingFields, scraperName }),
      (count) => `${count} 部影片`
    )
  }, [refreshVideoBatchScopeCount])

  useEffect(() => {
    if (!showVideoBatchModal) {
      resetVideoBatchScopeCount()
      return
    }
    void refreshVideoBatchScopeHint(0)
  }, [refreshVideoBatchScopeHint, resetVideoBatchScopeCount, showVideoBatchModal])

  const refreshActressBatchScopeHint = useCallback(async (
    scope: ActressBatchScrapeScope,
    missingFields: ActressScrapeField[] = [],
    scrapeStatus: ActressBatchScrapeStatus = 'unscraped'
  ): Promise<void> => {
    await refreshActressBatchScopeCount(
      () => api.actressScrape.batchCount({ scope, scrapeStatus, missingFields }),
      (count) => `${count} 位演员`
    )
  }, [refreshActressBatchScopeCount])

  useEffect(() => {
    if (!showActressBatchModal) {
      resetActressBatchScopeCount()
      return
    }
    void refreshActressBatchScopeHint('female', [], 'unscraped')
  }, [refreshActressBatchScopeHint, resetActressBatchScopeCount, showActressBatchModal])

  const onSettingsTabKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>): void => {
      const tabs = activeGroup.tabs
      if (tabs.length < 2) return
      const index = tabs.findIndex((tab) => tab.id === activeTab)
      if (index < 0) return
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        navigate(settingsPath(activeGroup.id, tabs[(index + 1) % tabs.length].id))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        navigate(settingsPath(activeGroup.id, tabs[(index - 1 + tabs.length) % tabs.length].id))
      } else if (e.key === 'Home') {
        e.preventDefault()
        navigate(settingsPath(activeGroup.id, tabs[0].id))
      } else if (e.key === 'End') {
        e.preventDefault()
        navigate(settingsPath(activeGroup.id, tabs[tabs.length - 1].id))
      }
    },
    [activeGroup, activeTab, navigate]
  )

  if (!settings) {
    if (settingsLoadError) {
      return (
        <EmptyState
          title="设置加载失败"
          description={settingsLoadError}
        >
          <Button type="button" variant="primary" onClick={() => setSettingsLoadAttempt((value) => value + 1)}>
            重试
          </Button>
        </EmptyState>
      )
    }
    return (
      <EmptyState loading title={<span className="settings-loading-label">加载设置…</span>} />
    )
  }

  const changeTheme = async (id: ThemeId): Promise<void> => {
    await setTheme(id)
    setSettings((s) => (s ? { ...s, theme: id } : s))
  }

  const patchAppearanceSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | 'videoDetailUseFirstSampleBackground'
        | 'actressDetailUseFirstGalleryBackground'
        | 'showVideoResourceTypeBadges'
        | 'privacyModeEnabled'
        | 'privacyModeScopes'
        | 'avatarFaceRatio'
        | 'avatarCenteringMode'
        | 'avatarPreserveFullHead'
      >
    >
  ): Promise<boolean> => {
    if (!settings) return false
    try {
      const next = await api.settings.update(patch)
      setSettings(next)
      if (patch.privacyModeEnabled !== undefined || patch.privacyModeScopes !== undefined) {
        syncPrivacyMode(next)
      }
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    }
  }

  const toggleAssetEncryption = async (enabled: boolean): Promise<void> => {
    if (!settings || storageBusy || settings.assetEncryption === enabled) return
    const msg = enabled
      ? '将加密全库封面、头像、样张与清单封面（.enc），处理期间应用暂时不可用。继续？'
      : '将解密全库封面、头像、样张与清单封面，处理期间应用暂时不可用。继续？'
    if (!window.confirm(msg)) return
    setStorageBusy(true)
    try {
      const next = await api.assetCrypto.setEnabled(enabled)
      setSettings(next)
      toast.show(enabled ? '图片加密已开启' : '图片加密已关闭', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setStorageBusy(false)
    }
  }

  const relocateMediaAssets = async (targetPath?: string | null): Promise<void> => {
    if (!settings || storageBusy) return
    const msg =
      targetPath === null
        ? '将把全部媒体资源迁移回默认目录，处理期间应用暂时不可用。继续？'
        : '将把全部媒体资源迁移到新目录（含加密与未加密文件），处理期间应用暂时不可用。继续？'
    if (!window.confirm(msg)) return
    setStorageBusy(true)
    try {
      const next = await api.assetStorage.relocate(targetPath)
      setSettings(next)
      toast.show('媒体资源目录已更新', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setStorageBusy(false)
    }
  }

  const startVideoBatchDefault = (): void => {
    if (!settings) return
    void startVideoBatch(
      ALL_VIDEO_SCRAPE_FIELDS,
      settings.defaultScraper,
      0,
      'fillEmpty',
      []
    )
  }

  const startActressBatchDefault = (): void => {
    if (!settings) return
    void startActressBatch(
      ALL_ACTRESS_SCRAPE_FIELDS,
      settings.defaultActressScraper,
      'female',
      'fillEmpty',
      [],
      false,
      'unscraped'
    )
  }

  const startActressBatch = async (
    fields: ActressScrapeField[],
    site: string,
    scope: ActressBatchScrapeScope,
    mode?: ActressScrapeUpdateMode,
    missingFields: ActressScrapeField[] = [],
    useAliases?: boolean,
    scrapeStatus: ActressBatchScrapeStatus = 'unscraped',
    autoCropAvatar = false
  ): Promise<void> => {
    setShowActressBatchModal(false)
    try {
      await api.actressScrape.batchStart({
        fields,
        scraperName: site || undefined,
        scope,
        scrapeStatus,
        missingFields,
        mode,
        useAliases,
        autoCropAvatar
      })
      toast.show('已开始演员批量刮削', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const startVideoBatch = async (
    fields: VideoScrapeField[],
    site: string,
    status: VideoBatchScrapeStatus,
    mode?: VideoScrapeUpdateMode,
    missingFields: VideoScrapeField[] = []
  ): Promise<void> => {
    setShowVideoBatchModal(false)
    try {
      await api.scrape.videoBatchStart({
        fields,
        scraperName: site || undefined,
        status,
        missingFields,
        mode
      })
      toast.show('已开始影片批量更新', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const cancelVideoBatch = async (): Promise<boolean> => {
    try {
      await api.batchScrape.pause()
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    }
  }

  const cancelActressBatch = async (): Promise<boolean> => {
    try {
      await api.batchScrape.pause()
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    }
  }

  const resumeBatch = async (): Promise<boolean> => {
    try {
      await api.batchScrape.resume()
      toast.show('已继续批量刮削', 'success')
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    }
  }

  const discardBatch = async (_kind: 'video' | 'actress'): Promise<boolean> => {
    try {
      await api.batchScrape.discard()
      toast.show('已终止批量刮削任务', 'success')
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    }
  }

  const navigateSettings = (group: SettingsGroup, tab?: SettingsTab): void => {
    navigate(settingsPath(group, tab))
  }

  const openActressConflicts = (): void => {
    setBatchDetailScope(null)
    navigate(pendingCenterPath({ type: 'actress' }))
  }

  const openVideoPending = (): void => {
    setBatchDetailScope(null)
    navigate(pendingCenterPath({ type: 'scrape' }))
  }

  const unrecognizedCount = unrecognized.length
  const videoBatchRunning = videoBatch?.status === 'running'
  const actressBatchRunning = actressBatch?.status === 'running'
  const videoBatchPaused = videoBatch?.status === 'paused'
  const actressBatchPaused = actressBatch?.status === 'paused'
  const avatarBatchRunning =
    avatarAutoCropBatch.state.status === 'running' ||
    avatarAutoCropBatch.state.status === 'cancelling'
  const avatarBatchStatus: BatchProgress['status'] =
    avatarAutoCropBatch.state.status === 'done'
      ? avatarAutoCropBatch.state.cancelled
        ? 'cancelled'
        : 'done'
      : avatarBatchRunning
        ? 'running'
        : 'idle'
  const avatarBatchProgress: BatchProgress | null =
    avatarAutoCropBatch.state.total > 0 || avatarAutoCropBatch.state.logs.length > 0
      ? {
          total: avatarAutoCropBatch.state.total,
          current: avatarAutoCropBatch.state.current,
          success: avatarAutoCropBatch.state.success,
          pending: 0,
          failed: avatarAutoCropBatch.state.failed,
          currentCode:
            avatarAutoCropBatch.state.status === 'cancelling'
              ? '正在停止…'
              : avatarAutoCropBatch.state.currentName,
          status: avatarBatchStatus,
          logs: avatarAutoCropBatch.state.logs
        }
      : null
  const scrapeBatchActive =
    videoBatchRunning || actressBatchRunning || videoBatchPaused || actressBatchPaused
  const anyBatchActive = scrapeBatchActive || avatarBatchRunning
  const batchPercent = (batch: BatchProgress | null): number =>
    batch && batch.total > 0 ? Math.round((batch.current / batch.total) * 100) : 0
  const videoBatchPct = batchPercent(videoBatch)
  const actressPct = batchPercent(actressBatch)
  const updateRelease = updateCheckState?.latestRelease
  const ignoreOverviewUpdate = (version: string): void => {
    void api.appUpdate
      .ignoreVersion(version)
      .then(setUpdateCheckState)
      .catch((error) => toast.show(String((error as Error).message ?? error), 'error'))
  }
  const shouldShowUpdateNotice =
    updateCheckState?.status === 'available' &&
    Boolean(updateRelease) &&
    updateRelease?.version !== updateCheckState.ignoredVersion
  const overviewNotices = [
    ...(settings.recoveryNotice &&
    settings.recoveryNotice.backupFileName !== dismissedRecoveryBackup
      ? [
          {
            tone: 'warning' as const,
            title: '设置已从损坏文件恢复',
            body: `${settings.recoveryNotice.message}；备份文件：${settings.recoveryNotice.backupFileName}`,
            secondaryAction: () =>
              setDismissedRecoveryBackup(settings.recoveryNotice?.backupFileName ?? null),
            secondaryActionLabel: '知道了',
            action: () => {
              void api.settings
                .revealRecoveryBackup()
                .then((opened) => {
                  if (!opened) toast.show('设置备份文件已不存在', 'info')
                })
                .catch((error) =>
                  toast.show(String((error as Error).message ?? error), 'error')
                )
            },
            actionLabel: '打开备份位置'
          }
        ]
      : []),
    ...(shouldShowUpdateNotice && updateRelease
      ? [
          {
            tone: 'info' as const,
            title: `Javdex ${updateRelease.version} 已发布`,
            body: summarizeReleaseNotes(updateRelease.releaseNotes),
            secondaryAction: () => ignoreOverviewUpdate(updateRelease.version),
            secondaryActionLabel: '忽略此版本',
            action: () => navigateSettings('about'),
            actionLabel: '查看更新',
            actionPrimary: true
          }
        ]
      : []),
    ...(settings.libraryPaths.length === 0
      ? [
          {
            tone: 'warning' as const,
            title: '尚未添加媒体库路径',
            body: '添加本地文件夹后才能扫描和导入影片。',
            action: () => navigateSettings('library'),
            actionLabel: '去添加'
          }
        ]
      : []),
    ...(unrecognizedCount > 0
      ? [
          {
            tone: 'warning' as const,
            title: '存在无法识别的文件',
            body: `${unrecognizedCount} 个文件需要手动填写番号或重命名。`,
            action: () => navigate(settingsPath('library'), { state: { libraryFocus: 'unrecognized' } }),
            actionLabel: '查看'
          }
        ]
      : []),
    ...(overviewStats && overviewStats.videos.unscraped > 0
      ? [
          {
            tone: 'info' as const,
            title: `${overviewStats.videos.unscraped} 部影片尚未刮削`,
            body: '使用默认刮削插件批量补齐元数据与封面。',
            action: startVideoBatchDefault,
            actionLabel: '一键刮削',
            actionPrimary: true
          }
        ]
      : []),
    ...(overviewStats && overviewStats.actresses.unscraped > 0
      ? [
          {
            tone: 'info' as const,
            title: `${overviewStats.actresses.unscraped} 位女优资料未完善`,
            body: '刮削演员资料可补全头像、简介与身体数据。',
            action: startActressBatchDefault,
            actionLabel: '一键刮削',
            actionPrimary: true
          }
        ]
      : [])
  ]

  const pluginDevPage = (
    <SettingsPluginDevShell>
      <PluginDevPanel
        settings={settings}
        setSettings={setSettings}
        loadPackage={devLoadPackage}
        onLoadConsumed={clearDevLoadPackage}
        onInstalled={handleInstalled}
      />
    </SettingsPluginDevShell>
  )

  const settingsPage = (
    <>
      <SettingsWorkspaceShell
        activeGroup={activeGroup}
        activeTab={activeTab}
        onNavigate={navigateSettings}
        onTabKeyDown={onSettingsTabKeyDown}
      >
              {activeGroup.id === 'overview' && (
                <SettingsOverviewPanel
                  settings={settings}
                  theme={theme}
                  themeLabel={THEME_OPTIONS.find((item) => item.id === theme)?.label ?? theme}
                  notices={overviewNotices}
                  videoPluginCount={videoPluginDetails.length}
                  actressPluginCount={actressPluginDetails.length}
                  videoBatch={videoBatch}
                  actressBatch={actressBatch}
                  anyBatchActive={anyBatchActive}
                  videoBatchPct={videoBatchPct}
                  actressPct={actressPct}
                  actressConflictGroupCount={actressConflictGroupCount}
                  unrecognizedCount={unrecognizedCount}
                  statsRefreshKey={overviewStatsRefreshKey}
                  onNavigate={navigateSettings}
                  onNavigateLibraryUnrecognized={() =>
                    navigate(settingsPath('library'), { state: { libraryFocus: 'unrecognized' } })
                  }
                  onOpenAgentTool={(toolId) => {
                    if (toolId === 'plugin-dev') navigate(settingsPluginDevPath())
                  }}
                  onStartVideoBatchDefault={startVideoBatchDefault}
                  onStartActressBatchDefault={startActressBatchDefault}
                  onOpenVideoBatchAdvanced={() => setShowVideoBatchModal(true)}
                  onOpenActressBatchAdvanced={() => setShowActressBatchModal(true)}
                  onOpenVideoBatchDetails={() => setBatchDetailScope('video')}
                  onOpenActressBatchDetails={() => setBatchDetailScope('actress')}
                  onOpenActressConflicts={openActressConflicts}
                  onPauseVideoBatch={cancelVideoBatch}
                  onPauseActressBatch={cancelActressBatch}
                  onResumeBatch={resumeBatch}
                  onDiscardVideoBatch={() => discardBatch('video')}
                  onDiscardActressBatch={() => discardBatch('actress')}
                  actressBatchRecoverable={actressBatchRecoverable}
                  actressBatchUnrecoverableReason={actressBatchUnrecoverableReason}
                />
              )}

              {activeGroup.id === 'library' && (
                <LibrarySettingsPanel
                  settings={settings}
                  scanning={scanning}
                  scanStatus={scanStatus}
                  scanResult={scanResult}
                  unrecognized={unrecognized}
                  unrecognizedRef={libraryUnrecRef}
                  onAddFolders={() => void addFolders()}
                  onRunScan={() => void runScan()}
                  onCancelScan={() => void cancelScan()}
                  onRequestRemovePath={(path) => void requestRemovePath(path)}
                  onResolvedUnrecognized={handleResolved}
                  onPatchSettings={(patch) => void patchLibrarySettings(patch)}
                  scanScrapePrompt={scanScrapePrompt}
                  videoBatchActive={anyBatchActive}
                  defaultScraper={settings.defaultScraper}
                  onDismissScanScrapePrompt={dismissScanScrapePrompt}
                  onStartScanScrapeBatch={startVideoBatchDefault}
                  onOpenPending={() => navigate(pendingCenterPath({ type: 'scan' }))}
                />
              )}

              {activeGroup.id === 'plugins' && (
                <PluginsSettingsPanel
                  videoUserPlugins={videoUserPlugins}
                  actressUserPlugins={actressUserPlugins}
                  videoCompositePlugins={videoCompositePlugins}
                  actressCompositePlugins={actressCompositePlugins}
                  defaultVideoPluginName={settings.defaultScraper}
                  defaultActressPluginName={settings.defaultActressScraper}
                  pluginBusy={pluginBusy}
                  onImport={() => void importPlugin()}
                  onOpenDev={() => navigate(settingsPluginDevPath())}
                  onEdit={(kind, plugin) => {
                    if (plugin.source === 'composite') {
                      setEditingComposite({ kind, plugin })
                      return
                    }
                    setEditingPlugin({ kind, plugin })
                  }}
                  onExport={(kind, name) => void exportPlugin(kind, name)}
                  onAiDebug={(kind, name) => void loadPluginForAiDebug(kind, name)}
                  onRequestDelete={setPluginDeleteTarget}
                  onSetDefault={(kind, name) => void changeDefaultPlugin(kind, name)}
                  onCreateComposite={(kind) => setEditingComposite({ kind })}
                />
              )}

              {activeGroup.id === 'appearance' && activeTab === 'theme' && (
                <AppearanceSettingsPanel
                  settings={settings}
                  theme={theme}
                  onThemeChange={changeTheme}
                  onPatchSettings={patchAppearanceSettings}
                  onOpenAvatarBatchDetails={() => setBatchDetailScope('avatar')}
                  scrapeBatchActive={scrapeBatchActive}
                />
              )}

              {activeGroup.id === 'storage' && activeTab === 'assets' && (
                <StorageSettingsPanel
                  settings={settings}
                  storageBusy={storageBusy}
                  onPickMediaAssetsPath={() => void relocateMediaAssets()}
                  onResetMediaAssetsPath={() => void relocateMediaAssets(null)}
                  onToggleAssetEncryption={(checked) => void toggleAssetEncryption(checked)}
                />
              )}

              {activeGroup.id === 'models' && activeTab === 'providers' && (
                <ModelSettingsPanel settings={settings} onSettingsChange={setSettings} />
              )}

              {activeGroup.id === 'network' && activeTab === 'proxy' && settings && (
                <NetworkSettingsPanel
                  scrapeProxySaved={settings.proxyUrl}
                  scrapeProxyEnabled={settings.proxyUrlEnabled}
                  scrapeProxyToggleBusy={proxyToggleBusy === 'scrape'}
                  scrapeProxySaving={proxySaving === 'scrape'}
                  scrapeProxyTesting={proxyTesting === 'scrape'}
                  llmProxySaved={settings.llmProxyUrl}
                  llmProxyEnabled={settings.llmProxyUrlEnabled}
                  llmProxyToggleBusy={proxyToggleBusy === 'llm'}
                  llmProxySaving={proxySaving === 'llm'}
                  llmProxyTesting={proxyTesting === 'llm'}
                  onScrapeProxyDraftChange={setScrapeProxyDraft}
                  onLlmProxyDraftChange={setLlmProxyDraft}
                  onScrapeProxyEnabledChange={(enabled) => void toggleScrapeProxyEnabled(enabled)}
                  onLlmProxyEnabledChange={(enabled) => void toggleLlmProxyEnabled(enabled)}
                  onSaveScrapeProxy={saveScrapeProxyUrl}
                  onSaveLlmProxy={saveLlmProxyUrl}
                  onTestScrapeProxy={(value) => testScrapeProxy(value)}
                  onTestLlmProxy={(value) => testLlmProxy(value)}
                />
              )}

              {activeGroup.id === 'about' && activeTab === 'info' && <AboutSettingsPanel />}
      </SettingsWorkspaceShell>

      {batchDetailScope && (
        <Modal
          title={
            batchDetailScope === 'actress'
              ? '批量刮削（演员）'
              : batchDetailScope === 'avatar'
                ? '批量智能构图（头像）'
                : '批量更新（影片）'
          }

          size="xl"
          className="modal--batch-detail"
          bodyClassName="modal-body--batch-detail"
          hideActions
          onCancel={() => setBatchDetailScope(null)}
        >
          <BatchSettingsPanel
            scope={batchDetailScope}
            batch={
              batchDetailScope === 'actress'
                ? actressBatch
                : batchDetailScope === 'avatar'
                  ? avatarBatchProgress
                  : videoBatch
            }
            running={
              batchDetailScope === 'actress'
                ? actressBatchRunning
                : batchDetailScope === 'avatar'
                  ? avatarBatchRunning
                  : videoBatchRunning
            }
            paused={
              batchDetailScope === 'actress'
                ? actressBatchPaused
                : batchDetailScope === 'avatar'
                  ? false
                  : videoBatchPaused
            }
            canResume={batchDetailScope !== 'actress' || actressBatchRecoverable}
            resumeDisabledReason={
              batchDetailScope === 'actress' ? actressBatchUnrecoverableReason : null
            }
            logRef={
              batchDetailScope === 'actress'
                ? actressLogRef
                : batchDetailScope === 'avatar'
                  ? avatarBatchLogRef
                  : videoBatchLogRef
            }
            emptyLog={
              batchDetailScope === 'actress'
                ? '暂无演员任务日志'
                : batchDetailScope === 'avatar'
                  ? '暂无头像构图任务日志'
                  : '暂无影片任务日志'
            }
            skipped={
              batchDetailScope === 'avatar' ? avatarAutoCropBatch.state.skipped : undefined
            }
            customControls={
              batchDetailScope === 'avatar' ? (
                avatarBatchRunning && avatarAutoCropBatch.state.source === 'manual' ? (
                  <Button
                    type="button"
                    variant="danger"

                    size="sm"
                    disabled={avatarAutoCropBatch.state.status === 'cancelling'}
                    onClick={avatarAutoCropBatch.cancel}
                  >
                    {avatarAutoCropBatch.state.status === 'cancelling'
                      ? '正在停止…'
                      : '停止任务'}
                  </Button>
                ) : null
              ) : undefined
            }
            pendingGroupCount={
              batchDetailScope === 'actress'
                ? actressConflictGroupCount
                : batchDetailScope === 'video'
                  ? videoBatch?.pending ?? 0
                  : 0
            }
            onOpenPending={
              batchDetailScope === 'actress'
                ? openActressConflicts
                : batchDetailScope === 'video'
                  ? openVideoPending
                  : undefined
            }
            onPause={() => {
              if (batchDetailScope === 'avatar') {
                avatarAutoCropBatch.cancel()
                return true
              }
              return batchDetailScope === 'actress' ? cancelActressBatch() : cancelVideoBatch()
            }}
            onResume={() => (batchDetailScope === 'avatar' ? false : resumeBatch())}
            onDiscard={() =>
              batchDetailScope === 'avatar' ? false : discardBatch(batchDetailScope)
            }
          />
        </Modal>
      )}

      {showVideoBatchModal && settings && (
        <ScrapeFieldsModal<VideoScrapeField, VideoBatchScrapeStatus>
          title="影片批量更新"
          hint="先确定范围与更新方式，再勾选要写入的字段。"
          options={VIDEO_SCRAPE_FIELD_OPTIONS}
          initialSelected={ALL_VIDEO_SCRAPE_FIELDS}
          scrapers={scrapers}
          pluginDetails={videoPluginDetails}
          initialScraperName={settings.defaultScraper}
          scraperTitle="刮削站点"
          confirmText="开始批量更新"
          updateModeOptions={VIDEO_SCRAPE_UPDATE_MODE_OPTIONS}
          scopeOptions={VIDEO_BATCH_SCRAPE_STATUS_OPTIONS}
          initialScope={0}
          scopeCountLabel={videoBatchScopeCountLabel}
          onScopeChange={(status, missingFields, _auxScope, scraperName) =>
            void refreshVideoBatchScopeHint(status, missingFields, scraperName)
          }
          missingFieldOptions={VIDEO_SCRAPE_FIELD_OPTIONS}
          missingFieldHint="选择后包含缺少任一所选字段的影片。"
          onMissingFieldsChange={(missingFields, status, _auxScope, scraperName) => {
            if (status !== undefined) {
              void refreshVideoBatchScopeHint(status, missingFields, scraperName)
            }
          }}
          onCancel={() => setShowVideoBatchModal(false)}
          onConfirm={(fields, site, status, mode, missingFields) => {
            if (status !== undefined) {
              void startVideoBatch(
                fields,
                site,
                status,
                mode as VideoScrapeUpdateMode,
                missingFields ?? []
              )
            }
          }}
        />
      )}

      {showActressBatchModal && settings && (
        <ScrapeFieldsModal<ActressScrapeField, ActressBatchScrapeScope, ActressBatchScrapeStatus>
          title="演员批量刮削"
          hint="先确定范围与更新方式，再勾选要写入的字段。"
          options={ACTRESS_SCRAPE_FIELD_OPTIONS}
          initialSelected={ALL_ACTRESS_SCRAPE_FIELDS}
          scrapers={actressScrapers}
          pluginDetails={actressPluginDetails}
          initialScraperName={settings.defaultActressScraper}
          scraperTitle="演员刮削站点"
          confirmText="开始批量刮削"
          updateModeOptions={ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS}
          scopeOptions={ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS}
          initialScope="female"
          scopeTitle="演员性别"
          auxScopeOptions={ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS}
          initialAuxScope="unscraped"
          auxScopeTitle="刮削状态"
          scopeCountLabel={actressBatchScopeCountLabel}
          onScopeChange={(scope, missingFields, scrapeStatus) =>
            void refreshActressBatchScopeHint(scope, missingFields, scrapeStatus ?? 'unscraped')
          }
          missingFieldOptions={ACTRESS_SCRAPE_FIELD_OPTIONS}
          missingFieldHint="选择后包含缺少任一所选字段的演员。"
          showUseAliasesToggle
          useAliasesHint="开启后，主名未匹配时会依次尝试中文名、英文名及已存别名。"
          showAutoCropAvatarToggle
          autoCropAvatarHint="头像保存后立即按“外观”设置构图，完成后再继续下一位演员。"
          onMissingFieldsChange={(missingFields, scope, scrapeStatus) => {
            if (scope !== undefined) {
              void refreshActressBatchScopeHint(scope, missingFields, scrapeStatus ?? 'unscraped')
            }
          }}
          onCancel={() => setShowActressBatchModal(false)}
          onConfirm={(
            fields,
            site,
            scope,
            mode,
            missingFields,
            _matchName,
            useAliases,
            scrapeStatus,
            autoCropAvatar
          ) => {
            if (scope !== undefined) {
              void startActressBatch(
                fields,
                site,
                scope,
                mode as ActressScrapeUpdateMode,
                missingFields ?? [],
                useAliases,
                scrapeStatus ?? 'unscraped',
                autoCropAvatar
              )
            }
          }}
        />
      )}

      {editingPlugin && (
        <PluginConfigModal
          state={editingPlugin}
          saving={pluginBusy === `${editingPlugin.kind}-update:${editingPlugin.plugin.name}`}
          onSave={(kind, name, input) => void savePluginConfig(kind, name, input)}
          onCancel={() => setEditingPlugin(null)}
        />
      )}
      {editingComposite && (
        <CompositeConfigModal
          state={editingComposite}
          saving={pluginBusy?.startsWith(`${editingComposite.kind}-composite:`) ?? false}
          plugins={editingComposite.kind === 'video' ? videoPluginDetails : actressPluginDetails}
          onSave={(kind, originalName, input) =>
            void saveCompositePlugin(kind, originalName, input)
          }
          onCancel={() => setEditingComposite(null)}
        />
      )}
      {pathRemoval && (
        <ConfirmModal
          title="移除媒体库路径"
          confirmText={
            pathRemoveBusy === 'preview'
              ? '正在统计…'
              : pathRemoveBusy === 'confirm'
                ? '移除中…'
                : '确认移除'
          }
          danger
          busy={Boolean(pathRemoveBusy)}
          confirmDisabled={!pathRemoval.preview}
          onCancel={closePathRemoval}
          onConfirm={() => void confirmRemovePath()}
        >
          <p>确定从媒体库中移除以下路径？</p>
          <div className="modal-path-text">{pathRemoval.path}</div>
          {pathRemoval.preview ? (
            <div className="library-path-removal-impact" aria-label="目录移除影响">
              <div>
                <strong>{pathRemoval.preview.localResourceCount}</strong>
                <span>条本地资源记录</span>
              </div>
              <div>
                <strong>{pathRemoval.preview.strmResourceCount}</strong>
                <span>条 STRM 资源记录</span>
              </div>
              <div>
                <strong>{pathRemoval.preview.videosBecomingResourceLess}</strong>
                <span>部影片可能变为无资源</span>
              </div>
            </div>
          ) : (
            <p className="modal-field-hint" aria-live="polite">正在统计目录影响…</p>
          )}
          <p className="modal-field-hint library-path-removal-note">
            确认后会立即停止扫描该路径。下一次成功完成的扫描将移除上述资源记录，
            但不会删除目录中的视频文件或 STRM 源文件；此操作不提供保留资源记录选项。
          </p>
        </ConfirmModal>
      )}
      {pluginDeleteTarget && (
        <ConfirmModal
          title={pluginDeleteTarget.composite ? '删除组合插件' : '删除插件'}
          confirmText={pluginBusy ? '删除中…' : '删除'}
          danger
          busy={Boolean(pluginBusy)}
          onCancel={() => setPluginDeleteTarget(null)}
          onConfirm={() => void confirmPluginDelete()}
        >
          <p>
            确定删除「{pluginDeleteTarget.name}」？
            {pluginDeleteTarget.composite ? '组合配置' : '插件'}
            删除后不可恢复。
          </p>
        </ConfirmModal>
      )}
    </>
  )

  return <Outlet context={{ settingsPage, pluginDevPage }} />
}
