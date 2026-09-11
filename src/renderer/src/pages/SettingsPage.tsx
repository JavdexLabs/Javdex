import { avatarLogNotice } from '../avatarAutoCrop/logs'
import WebAccessPanel from '../components/settings/WebAccessPanel'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import type { ActressBatchScrapeScope, ActressBatchScrapeStatus, ActressScrapeField, ActressScrapeUpdateMode, VideoBatchScrapeStatus, VideoScrapeField, VideoScrapeUpdateMode } from '@shared/scrapeTypes'
import type { AppSettings, SettingsSnapshot } from '@shared/settingsTypes'
import type { BatchProgress } from '@shared/batchScrapeTypes'
import { ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS, ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS, ACTRESS_SCRAPE_FIELD_OPTIONS, ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS, ALL_ACTRESS_SCRAPE_FIELDS, ALL_VIDEO_SCRAPE_FIELDS, VIDEO_BATCH_SCRAPE_STATUS_OPTIONS, VIDEO_SCRAPE_FIELD_OPTIONS, VIDEO_SCRAPE_UPDATE_MODE_OPTIONS } from '@shared/scrapeTypes'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { api } from '../api'
import { actressKeys, mediaLibraryKeys, overviewStatsKeys } from '../query/queryKeys'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import Modal from '../components/Modal'
import PluginDevPanel from '../components/pluginDev/PluginDevPanel'
import AppearanceSettingsPanel from '../components/settings/AppearanceSettingsPanel'
import AboutSettingsPanel from '../components/settings/AboutSettingsPanel'
import BatchSettingsPanel from '../components/settings/BatchSettingsPanel'
import ModelSettingsPanel from '../components/settings/ModelSettingsPanel'
import NetworkSettingsPanel from '../components/settings/NetworkSettingsPanel'
import PluginsSettingsPanel from '../components/settings/PluginsSettingsPanel'
import StorageSettingsPanel from '../components/settings/StorageSettingsPanel'
import SettingsOverviewPanel from '../components/settings/SettingsOverviewPanel'
import { MediaLibrarySettingsContent } from './MediaLibrarySettingsPage'
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
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import { useAvatarAutoCropBatch } from '../contexts/AvatarAutoCropBatchContext'
import { pendingCenterPath } from '../listView/pendingRoutes'
import {
  isMediaLibrarySettingsTab,
  mediaLibrarySettingsPath,
  parseMediaLibrarySettingsLibraryId,
  peekMediaLibrarySettingsLibraryId,
  rememberMediaLibrarySettingsLibraryId,
  type MediaLibrarySettingsTab
} from '../listView/mediaLibraryRoutes'
import useLatestAsyncLabel from '../hooks/useLatestAsyncLabel'
import useScraperPluginSettingsController from '../hooks/useScraperPluginSettingsController'
import {
  resolveSettingsRoute,
  settingsPath,
  settingsPluginDevPath,
  settingsTabDomId,
  type SettingsGroup,
  type SettingsTab
} from '../settings/settingsRoutes'
import { THEME_OPTIONS } from '../theme'
import type { ThemeId } from '@shared/settingsTypes'
import type { UpdateCheckState } from '@shared/updateTypes'
import Button from '../components/Button'
import MediaLibraryCreateModal from '../components/MediaLibraryCreateModal'
import {
  withVideoBatchFilterScope,
  withVideoBatchRequestScope
} from '../utils/videoBatchScope'

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
    openPluginEditor,
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
    testPluginServiceConfig,
    clearPluginServiceConfig,
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
  const mediaLibrariesQuery = useQuery({
    queryKey: mediaLibraryKeys.activeList(),
    queryFn: () => api.mediaLibraries.list(),
    refetchOnMount: 'always'
  })
  const mediaLibrarySettingsQuery = useQuery({
    queryKey: mediaLibraryKeys.fullList(),
    queryFn: () => api.mediaLibraries.list({ includeArchived: true }),
    enabled: activeGroup.id === 'library',
    refetchOnMount: 'always'
  })
  const requestedSettingsLibraryId = parseMediaLibrarySettingsLibraryId(location.search)
  const rememberedSettingsLibraryId = peekMediaLibrarySettingsLibraryId()
  const mediaLibrarySettingsLibraries = mediaLibrarySettingsQuery.data ?? []
  const selectedSettingsLibrary =
    mediaLibrarySettingsLibraries.find((library) => library.id === requestedSettingsLibraryId) ??
    mediaLibrarySettingsLibraries.find((library) => library.id === rememberedSettingsLibraryId) ??
    mediaLibrarySettingsLibraries.find(
      (library) => library.status === 'active' && library.isDefault
    ) ??
    mediaLibrarySettingsLibraries.find((library) => library.status === 'active') ??
    mediaLibrarySettingsLibraries[0] ??
    null
  const activeMediaLibrarySettingsTab: MediaLibrarySettingsTab =
    isMediaLibrarySettingsTab(activeTab) ? activeTab : 'sources'

  useEffect(() => {
    if (requestedSettingsLibraryId) {
      rememberMediaLibrarySettingsLibraryId(requestedSettingsLibraryId)
    }
  }, [requestedSettingsLibraryId])

  useEffect(() => {
    if (activeGroup.id !== 'library' || !selectedSettingsLibrary) return
    rememberMediaLibrarySettingsLibraryId(selectedSettingsLibrary.id)
    const canonical = mediaLibrarySettingsPath(
      selectedSettingsLibrary.id,
      activeMediaLibrarySettingsTab
    )
    if (`${location.pathname}${location.search}` === canonical) return
    navigate(canonical, { replace: true })
  }, [
    activeGroup.id,
    activeMediaLibrarySettingsTab,
    location.pathname,
    location.search,
    navigate,
    selectedSettingsLibrary
  ])
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
  const [createLibraryOpen, setCreateLibraryOpen] = useState(false)
  const [storageBusy, setStorageBusy] = useState(false)
  const [storageAction, setStorageAction] = useState<{ kind: 'crypto'; enabled: boolean } | { kind: 'relocate'; target: string | null } | null>(null)
  const [nfoExportBlocking, setNfoExportBlocking] = useState(false)
  const actressConflictSummaryQuery = useQuery({
    queryKey: actressKeys.conflictSummary(),
    queryFn: () => api.actressScrape.conflictSummary(),
    refetchInterval: 3000
  })
  const actressConflictGroupCount = actressConflictSummaryQuery.data?.groupCount ?? 0
  const videoBatchLogRef = useRef<HTMLDivElement>(null)
  const actressLogRef = useRef<HTMLDivElement>(null)
  const avatarBatchLogRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (activeGroup.id !== 'overview') return
    void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  }, [activeGroup.id, queryClient])

  const dismissSettingsOverlays = useCallback(() => {
    setEditingPlugin(null)
    setEditingComposite(null)
    setPluginDeleteTarget(null)
    setShowVideoBatchModal(false)
    setShowActressBatchModal(false)
    setBatchDetailScope(null)
  }, [setEditingComposite, setEditingPlugin, setPluginDeleteTarget])

  useDismissOverlaysOnNavigate(dismissSettingsOverlays, location.pathname)

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
  }, [avatarAutoCropBatch.state.totalLogCount])

  const refreshVideoBatchScopeHint = useCallback(async (
    status: VideoBatchScrapeStatus,
    missingFields: VideoScrapeField[] = [],
    scraperName?: string
  ): Promise<void> => {
    await refreshVideoBatchScopeCount(
      () =>
        api.scrape.videoBatchCount(
          withVideoBatchFilterScope(
            { kind: 'all' },
            { status, missingFields, scraperName }
          )
        ),
      (count) => `全局目录 · ${count} 部影片`
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
      let nextIndex: number
      if (e.key === 'ArrowRight') {
        nextIndex = (index + 1) % tabs.length
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (index - 1 + tabs.length) % tabs.length
      } else if (e.key === 'Home') {
        nextIndex = 0
      } else if (e.key === 'End') {
        nextIndex = tabs.length - 1
      } else return
      e.preventDefault()
      const nextTab = tabs[nextIndex].id
      navigate(
        activeGroup.id === 'library' &&
          selectedSettingsLibrary &&
          isMediaLibrarySettingsTab(nextTab)
          ? mediaLibrarySettingsPath(selectedSettingsLibrary.id, nextTab)
          : settingsPath(activeGroup.id, nextTab)
      )
      window.requestAnimationFrame(() => {
        document
          .getElementById(settingsTabDomId(activeGroup.id, nextTab))
          ?.focus()
      })
    },
    [activeGroup, activeTab, navigate, selectedSettingsLibrary]
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
    try {
      await setTheme(id)
      setSettings((s) => (s ? { ...s, theme: id } : s))
    } catch (error) {
      toast.show(`主题未保存：${(error as Error).message}`, 'error')
    }
  }

  const patchAppearanceSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | 'videoDetailUseFirstSampleBackground'
        | 'actressDetailUseFirstGalleryBackground'
        | 'showVideoResourceTypeBadges'
        | 'coverDisplayMode'
        | 'closeToTray'
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
      const savedPatch = Object.fromEntries(
        Object.keys(patch).map((key) => [key, next[key as keyof typeof patch]])
      )
      setSettings((current) => current ? { ...current, ...savedPatch } : next)
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
    setStorageAction({ kind: 'crypto', enabled })
  }

  const relocateMediaAssets = async (targetPath?: string | null): Promise<void> => {
    if (!settings || storageBusy) return
    try {
      const target = targetPath === undefined ? (await api.settings.pickFolder())[0] : targetPath
      if (target === undefined) return
      if (target === settings.mediaAssetsResolvedPath || (target === null && !settings.mediaAssetsPath)) {
        toast.show('已在使用该目录', 'info')
        return
      }
      setStorageAction({ kind: 'relocate', target })
    } catch (error) { toast.show((error as Error).message, 'error') }
  }

  const runStorageAction = async (): Promise<void> => {
    if (!storageAction || storageBusy) return
    setStorageBusy(true)
    try {
      const next = storageAction.kind === 'crypto'
        ? await api.assetCrypto.setEnabled(storageAction.enabled)
        : await api.assetStorage.relocate(storageAction.target)
      setSettings((current) => current ? { ...current, assetEncryption: next.assetEncryption, mediaAssetsPath: next.mediaAssetsPath, mediaAssetsResolvedPath: next.mediaAssetsResolvedPath } : next)
      toast.show(storageAction.kind === 'crypto' ? (storageAction.enabled ? '图片加密已开启' : '图片加密已关闭') : next.mediaAssetsResolvedPath === settings.mediaAssetsResolvedPath ? '目录未改变' : '图片资源目录已更新', 'success')
      setStorageAction(null)
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
    missingFields: VideoScrapeField[] = [],
    libraryId?: number
  ): Promise<void> => {
    setShowVideoBatchModal(false)
    try {
      await api.scrape.videoBatchStart(
        withVideoBatchRequestScope(
          libraryId === undefined ? { kind: 'all' } : { kind: 'library', libraryId },
          {
            fields,
            scraperName: site || undefined,
            status,
            missingFields,
            mode
          }
        )
      )
      toast.show(
        libraryId ? '已开始当前媒体库的影片批量更新' : '已开始全局目录的影片批量更新',
        'success'
      )
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
    if (group === 'library' && selectedSettingsLibrary) {
      navigate(
        mediaLibrarySettingsPath(
          selectedSettingsLibrary.id,
          isMediaLibrarySettingsTab(tab) ? tab : 'sources'
        )
      )
      return
    }
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
  const mediaLibraries = mediaLibrariesQuery.data ?? []
  const mediaLibraryRootCount = mediaLibraries.reduce(
    (total, library) => total + library.rootCount,
    0
  )
  const overviewMediaLibrarySettingsTarget =
    mediaLibraries.find((library) => library.id === peekMediaLibrarySettingsLibraryId()) ??
    mediaLibraries.find((library) => library.isDefault) ??
    mediaLibraries[0] ??
    null
  const openMediaLibrarySettings = (): void => {
    if (!overviewMediaLibrarySettingsTarget) {
      setCreateLibraryOpen(true)
      return
    }
    navigate(mediaLibrarySettingsPath(overviewMediaLibrarySettingsTarget.id, 'sources'))
  }
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
    ...(mediaLibrariesQuery.isError
      ? [
          {
            tone: 'warning' as const,
            title: '媒体库状态暂时无法读取',
            body: '独立媒体库配置未被修改，请重新读取状态。',
            action: () => {
              void mediaLibrariesQuery.refetch()
            },
            actionLabel: '重新读取'
          }
        ]
      : !mediaLibrariesQuery.isLoading && mediaLibraryRootCount === 0
      ? [
          {
            tone: 'warning' as const,
            title: '媒体库尚未配置来源目录',
            body: '请在媒体库设置中添加本地文件夹，然后运行该媒体库的扫描。',
            action: openMediaLibrarySettings,
            actionLabel: '打开媒体库设置'
          }
        ]
      : []),

  ]

  const pluginDevPage = (
    <SettingsPluginDevShell>
      <PluginDevPanel
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
        hrefForGroup={(group) =>
          group.id === 'library' && selectedSettingsLibrary
            ? mediaLibrarySettingsPath(
                selectedSettingsLibrary.id,
                isMediaLibrarySettingsTab(activeTab) ? activeTab : 'sources'
              )
            : settingsPath(group.id)
        }
        tabsPlacement={activeGroup.id === 'library' ? 'content' : 'shell'}
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
                  mediaLibraryCount={mediaLibraries.length}
                  mediaLibraryRootCount={mediaLibraryRootCount}
                  mediaLibrariesLoading={mediaLibrariesQuery.isLoading}
                  mediaLibrariesError={mediaLibrariesQuery.isError}
                  onNavigate={navigateSettings}
                  onOpenMediaLibrarySettings={openMediaLibrarySettings}
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

              {activeGroup.id === 'library' &&
                (mediaLibrarySettingsQuery.isLoading ? (
                  <EmptyState loading title="正在读取媒体库…" />
                ) : mediaLibrarySettingsQuery.isError ? (
                  <EmptyState
                    title="媒体库读取失败"
                    description="暂时无法读取媒体库配置。"
                  >
                    <Button
                      size="sm"
                      onClick={() => void mediaLibrarySettingsQuery.refetch()}
                    >
                      重新读取
                    </Button>
                  </EmptyState>
                ) : selectedSettingsLibrary ? (
                  <MediaLibrarySettingsContent
                    key={selectedSettingsLibrary.id}
                    libraryId={selectedSettingsLibrary.id}
                    tab={activeMediaLibrarySettingsTab}
                    libraries={mediaLibrarySettingsLibraries}
                    onSelectLibrary={(libraryId) =>
                      navigate(mediaLibrarySettingsPath(libraryId, activeMediaLibrarySettingsTab))
                    }
                    onSelectTab={(tab) =>
                      navigate(mediaLibrarySettingsPath(selectedSettingsLibrary.id, tab))
                    }
                    onTabKeyDown={onSettingsTabKeyDown}
                  />
                ) : (
                  <EmptyState
                    title="尚未配置媒体库"
                    description="创建媒体库并添加影片所在的文件夹，然后扫描导入。"
                  ><Button variant="primary" onClick={() => setCreateLibraryOpen(true)}>新建媒体库</Button></EmptyState>
                ))}

              {activeGroup.id === 'plugins' && (
                <PluginsSettingsPanel
                  kind={activeTab === 'actress' ? 'actress' : 'video'}
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
                    void openPluginEditor(kind, plugin)
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

              {activeGroup.id === 'storage' && (
                <StorageSettingsPanel
                  tab={activeTab === 'export' ? 'export' : 'assets'}
                  settings={settings}
                  storageBusy={storageBusy || nfoExportBlocking}
                  onPickMediaAssetsPath={() => void relocateMediaAssets()}
                  onResetMediaAssetsPath={() => void relocateMediaAssets(null)}
                  onToggleAssetEncryption={(checked) => void toggleAssetEncryption(checked)}
                  onExportBlockingChange={setNfoExportBlocking}
                />
              )}

              {activeGroup.id === 'models' && (
                <ModelSettingsPanel settings={settings} activeTab={activeTab === 'advanced' ? 'advanced' : activeTab === 'providers' ? 'providers' : 'usage'} />
              )}

              {activeGroup.id === 'network' && activeTab === 'proxy' && settings && (
                <NetworkSettingsPanel
                  settings={settings}
                  onSaved={(patch) => setSettings((current) => current ? { ...current, ...patch } : current)}
                />
              )}

              {activeGroup.id === 'network' && activeTab === 'web' && <WebAccessPanel />}

              {activeGroup.id === 'about' && activeTab === 'info' && <AboutSettingsPanel />}
      </SettingsWorkspaceShell>

      {createLibraryOpen ? <MediaLibraryCreateModal onCancel={() => setCreateLibraryOpen(false)} onCreated={(library, scanAfterCreate) => {
        setCreateLibraryOpen(false)
        void queryClient.invalidateQueries({ queryKey: ['media-libraries'] })
        navigate(mediaLibrarySettingsPath(library.id, 'sources'))
        if (scanAfterCreate) void api.scan.run(library.id).then(() => queryClient.invalidateQueries({ queryKey: ['media-libraries'] })).catch((error) => toast.show((error as Error).message, 'error'))
      }} /> : null}

      {storageAction ? <ConfirmModal
        title={storageAction.kind === 'crypto' ? (storageAction.enabled ? '启用图片加密' : '关闭图片加密') : '迁移图片资源'}
        confirmText="开始处理"
        busy={storageBusy}
        onCancel={() => setStorageAction(null)}
        onConfirm={() => void runStorageAction()}
      >
        {storageAction.kind === 'relocate' ? <>
          <p className="copyable-text">当前目录：{settings.mediaAssetsResolvedPath}</p>
          <p className="copyable-text">目标目录：{storageAction.target ?? '应用默认图片目录'}</p>
        </> : null}
        <p>将处理全库封面、头像、样张、写真与清单封面。处理期间应用暂时锁定，完成后恢复；影片源文件不受影响。</p>
      </ConfirmModal> : null}

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
            logNotice={batchDetailScope === 'avatar' ? avatarLogNotice(avatarAutoCropBatch.state) : undefined}
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
          hint="作用范围为全局目录。先确定影片状态与更新方式，再勾选要写入的字段。"
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
          saving={
            pluginBusy === `${editingPlugin.kind}-update:${editingPlugin.plugin.name}` ||
            pluginBusy === 'video-service-clear:MetaTube'
          }
          onSave={(kind, name, input, serviceInput) =>
            void savePluginConfig(kind, name, input, serviceInput)
          }
          onTestService={testPluginServiceConfig}
          onClearService={clearPluginServiceConfig}
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
