import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  ActressBatchScrapeScope,
  ActressBatchScrapeStatus,
  AppSettings,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  BatchProgress,
  CompositeScraperInput,
  ScanResult,
  ScraperPluginDescriptor,
  ScraperPluginPackage,
  ScraperPluginUpdateInput,
  VideoBatchScrapeStatus,
  VideoScrapeField,
  VideoScrapeUpdateMode
} from '@shared/types'
import {
  ACTRESS_BATCH_SCRAPE_SCOPE_OPTIONS,
  ACTRESS_BATCH_SCRAPE_STATUS_OPTIONS,
  ACTRESS_SCRAPE_FIELD_OPTIONS,
  ACTRESS_SCRAPE_UPDATE_MODE_OPTIONS,
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  VIDEO_BATCH_SCRAPE_STATUS_OPTIONS,
  VIDEO_SCRAPE_FIELD_OPTIONS,
  VIDEO_SCRAPE_UPDATE_MODE_OPTIONS
} from '@shared/types'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { api } from '../api'
import { overviewStatsKeys } from '../query/queryKeys'
import ConfirmModal from '../components/ConfirmModal'
import PluginDevPanel from '../components/pluginDev/PluginDevPanel'
import AppearanceSettingsPanel from '../components/settings/AppearanceSettingsPanel'
import BatchSettingsPanel from '../components/settings/BatchSettingsPanel'
import LibrarySettingsPanel from '../components/settings/LibrarySettingsPanel'
import ModelSettingsPanel from '../components/settings/ModelSettingsPanel'
import NetworkSettingsPanel from '../components/settings/NetworkSettingsPanel'
import PluginsSettingsPanel, { type PluginDeleteTarget } from '../components/settings/PluginsSettingsPanel'
import StorageSettingsPanel from '../components/settings/StorageSettingsPanel'
import SettingsOverviewPanel from '../components/settings/SettingsOverviewPanel'
import {
  CompositeConfigModal,
  PluginConfigModal,
  type CompositeEditState,
  type PluginEditState,
  type PluginKind
} from '../components/settings/PluginConfigModals'
import { SettingsTabBar } from '../components/settings/SettingsPrimitives'
import ScrapeFieldsModal from '../components/ScrapeFieldsModal'
import { useToast } from '../components/Toast'
import { useTheme } from '../components/ThemeProvider'
import { useLibraryOverviewStats } from '../hooks/useLibraryOverviewStats'
import { useBatchScrapeActivity } from '../hooks/useBatchScrapeActivity'
import {
  invalidateAllLibraryQueries
} from '../query/invalidateLibraryQueries'
import {
  dismissMaintenanceHint,
  MAINTENANCE_HINT_KEYS
} from '../utils/maintenanceHints'
import {
  SETTINGS_GROUPS,
  resolveSettingsRoute,
  settingsPath,
  settingsTabDomId,
  settingsTabPanelDomId,
  type SettingsGroup,
  type SettingsTab
} from '../settings/settingsRoutes'
import { THEME_OPTIONS } from '../theme'
import type { ThemeId } from '@shared/types'

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

export default function SettingsPage(): JSX.Element {
  const queryClient = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const { theme, setTheme } = useTheme()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [scrapeProxyDraft, setScrapeProxyDraft] = useState('')
  const [llmProxyDraft, setLlmProxyDraft] = useState('')
  const [proxySaving, setProxySaving] = useState<'scrape' | 'llm' | null>(null)
  const [proxyTesting, setProxyTesting] = useState<'scrape' | 'llm' | null>(null)
  const [proxyToggleBusy, setProxyToggleBusy] = useState<'scrape' | 'llm' | null>(null)
  const [scrapers, setScrapers] = useState<string[]>([])
  const [actressScrapers, setActressScrapers] = useState<string[]>([])
  const [videoPluginDetails, setVideoPluginDetails] = useState<ScraperPluginDescriptor[]>([])
  const [actressPluginDetails, setActressPluginDetails] = useState<ScraperPluginDescriptor[]>([])
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const [editingPlugin, setEditingPlugin] = useState<PluginEditState | null>(null)
  const [editingComposite, setEditingComposite] = useState<CompositeEditState | null>(null)
  const [pluginDeleteTarget, setPluginDeleteTarget] = useState<PluginDeleteTarget | null>(null)
  const [pathRemoveTarget, setPathRemoveTarget] = useState<string | null>(null)
  const [devLoadPackage, setDevLoadPackage] = useState<ScraperPluginPackage | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanStatus, setScanStatus] = useState('')
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [unrecognized, setUnrecognized] = useState<string[]>([])
  const { videoBatch, actressBatch } = useBatchScrapeActivity()
  const [showVideoBatchModal, setShowVideoBatchModal] = useState(false)
  const [showActressBatchModal, setShowActressBatchModal] = useState(false)
  const [videoBatchScopeCountLabel, setVideoBatchScopeCountLabel] = useState('- 部影片')
  const [actressBatchScopeCountLabel, setActressBatchScopeCountLabel] = useState('- 位演员')
  const [storageBusy, setStorageBusy] = useState(false)
  const [overviewStatsRefreshKey, setOverviewStatsRefreshKey] = useState(0)
  const [scanScrapePrompt, setScanScrapePrompt] = useState<{
    imported: number
    unscraped: number
  } | null>(null)
  const { stats: overviewStats } = useLibraryOverviewStats(overviewStatsRefreshKey)
  const videoBatchLogRef = useRef<HTMLDivElement>(null)
  const actressLogRef = useRef<HTMLDivElement>(null)
  const libraryUnrecRef = useRef<HTMLDivElement>(null)
  const isPluginDevPage = location.pathname.endsWith('/plugin-dev')
  const { group: activeGroup, tab: activeTab } = resolveSettingsRoute(location.pathname)

  useEffect(() => {
    if (activeGroup.id !== 'overview') return
    void queryClient.invalidateQueries({ queryKey: overviewStatsKeys.all })
  }, [activeGroup.id, queryClient])

  const dismissSettingsOverlays = useCallback(() => {
    setEditingPlugin(null)
    setEditingComposite(null)
    setPluginDeleteTarget(null)
    setPathRemoveTarget(null)
    setShowVideoBatchModal(false)
    setShowActressBatchModal(false)
  }, [])

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

  const refreshVideoPlugins = async (): Promise<void> => {
    const [names, details] = await Promise.all([
      api.scrape.listPlugins(),
      api.scrape.listPluginDetails()
    ])
    setScrapers(names)
    setVideoPluginDetails(details)
  }

  const refreshActressPlugins = async (): Promise<void> => {
    const [names, details] = await Promise.all([
      api.actressScrape.listPlugins(),
      api.actressScrape.listPluginDetails()
    ])
    setActressScrapers(names)
    setActressPluginDetails(details)
  }

  useEffect(() => {
    api.settings
      .get()
      .then((s) => {
        setSettings(s)
        setScrapeProxyDraft(s.proxyUrl)
        setLlmProxyDraft(s.llmProxyUrl)
      })
      .catch((e) => toast.show(String(e.message ?? e), 'error'))
    refreshVideoPlugins().catch(() => {})
    refreshActressPlugins().catch(() => {})
  }, [toast])

  useEffect(() => {
    const off = api.scan.onProgress((p) => {
      setScanStatus(`已扫描 ${p.scanned} 个文件，新导入 ${p.imported} 部`)
    })
    return off
  }, [])

  useEffect(() => {
    scrollBatchLogToBottom(videoBatchLogRef)
  }, [videoBatch?.logs.length])

  useEffect(() => {
    scrollBatchLogToBottom(actressLogRef)
  }, [actressBatch?.logs.length])

  const refreshVideoBatchScopeHint = async (
    status: VideoBatchScrapeStatus,
    missingFields: VideoScrapeField[] = []
  ): Promise<void> => {
    try {
      const n = await api.scrape.videoBatchCount({ status, missingFields })
      setVideoBatchScopeCountLabel(`${n} 部影片`)
    } catch {
      setVideoBatchScopeCountLabel('- 部影片')
    }
  }

  useEffect(() => {
    if (!showVideoBatchModal) return
    void refreshVideoBatchScopeHint(0)
  }, [showVideoBatchModal])

  const refreshActressBatchScopeHint = async (
    scope: ActressBatchScrapeScope,
    missingFields: ActressScrapeField[] = [],
    scrapeStatus: ActressBatchScrapeStatus = 'unscraped'
  ): Promise<void> => {
    try {
      const n = await api.actressScrape.batchCount({ scope, scrapeStatus, missingFields })
      setActressBatchScopeCountLabel(`${n} 位演员`)
    } catch {
      setActressBatchScopeCountLabel('- 位演员')
    }
  }

  useEffect(() => {
    if (!showActressBatchModal) return
    void refreshActressBatchScopeHint('female', [], 'unscraped')
  }, [showActressBatchModal])

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
    return (
      <div className="empty-state">
        <div className="spinner" />
        <p className="settings-loading-label">加载设置…</p>
      </div>
    )
  }

  const addFolders = async (): Promise<void> => {
    try {
      const picked = await api.settings.pickFolder()
      if (!picked.length) return
      const merged = Array.from(new Set([...settings.libraryPaths, ...picked]))
      const next = await api.settings.update({ libraryPaths: merged })
      setSettings(next)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const removeFolder = async (path: string): Promise<void> => {
    if (!settings) return
    try {
      const merged = settings.libraryPaths.filter((p) => p !== path)
      const next = await api.settings.update({ libraryPaths: merged })
      setSettings(next)
      toast.show('已移除媒体库路径', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const confirmRemovePath = async (): Promise<void> => {
    if (!pathRemoveTarget) return
    const target = pathRemoveTarget
    setPathRemoveTarget(null)
    await removeFolder(target)
  }

  const toggleScrapeProxyEnabled = async (enabled: boolean): Promise<void> => {
    if (!settings || proxyToggleBusy) return
    const proxyUrl = scrapeProxyDraft.trim()
    if (enabled && !proxyUrl) {
      toast.show('请先填写刮削代理地址', 'error')
      return
    }
    setProxyToggleBusy('scrape')
    try {
      const patch: Partial<AppSettings> = { proxyUrlEnabled: enabled }
      if (enabled && proxyUrl !== settings.proxyUrl) {
        patch.proxyUrl = proxyUrl
      }
      const next = await api.settings.update(patch)
      setSettings(next)
      setScrapeProxyDraft(next.proxyUrl)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setProxyToggleBusy(null)
    }
  }

  const toggleLlmProxyEnabled = async (enabled: boolean): Promise<void> => {
    if (!settings || proxyToggleBusy) return
    const llmProxyUrl = llmProxyDraft.trim()
    if (enabled && !llmProxyUrl) {
      toast.show('请先填写模型代理地址', 'error')
      return
    }
    setProxyToggleBusy('llm')
    try {
      const patch: Partial<AppSettings> = { llmProxyUrlEnabled: enabled }
      if (enabled && llmProxyUrl !== settings.llmProxyUrl) {
        patch.llmProxyUrl = llmProxyUrl
      }
      const next = await api.settings.update(patch)
      setSettings(next)
      setLlmProxyDraft(next.llmProxyUrl)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setProxyToggleBusy(null)
    }
  }

  const saveScrapeProxyUrl = async (proxyUrl: string): Promise<boolean> => {
    if (!settings || proxySaving) return false
    const trimmed = proxyUrl.trim()
    if (settings.proxyUrlEnabled && !trimmed) {
      toast.show('刮削代理已启用，请填写代理地址', 'error')
      return false
    }
    if (trimmed === settings.proxyUrl) return true
    setProxySaving('scrape')
    try {
      const next = await api.settings.update({ proxyUrl: trimmed })
      setSettings(next)
      setScrapeProxyDraft(next.proxyUrl)
      toast.show('刮削代理地址已保存', 'success')
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      setProxySaving(null)
    }
  }

  const saveLlmProxyUrl = async (llmProxyUrl: string): Promise<boolean> => {
    if (!settings || proxySaving) return false
    const trimmed = llmProxyUrl.trim()
    if (settings.llmProxyUrlEnabled && !trimmed) {
      toast.show('模型代理已启用，请填写代理地址', 'error')
      return false
    }
    if (trimmed === settings.llmProxyUrl) return true
    setProxySaving('llm')
    try {
      const next = await api.settings.update({ llmProxyUrl: trimmed })
      setSettings(next)
      setLlmProxyDraft(next.llmProxyUrl)
      toast.show('模型代理地址已保存', 'success')
      return true
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      return false
    } finally {
      setProxySaving(null)
    }
  }

  const testScrapeProxy = async (proxyUrl: string): Promise<void> => {
    if (proxyTesting) return
    const trimmed = proxyUrl.trim()
    if (!trimmed) {
      toast.show('请填写代理地址', 'error')
      return
    }
    setProxyTesting('scrape')
    try {
      const message = await api.settings.testProxy('scrape', trimmed)
      toast.show(`刮削代理${message}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setProxyTesting(null)
    }
  }

  const testLlmProxy = async (proxyUrl: string): Promise<void> => {
    if (proxyTesting) return
    const trimmed = proxyUrl.trim()
    if (!trimmed) {
      toast.show('请填写代理地址', 'error')
      return
    }
    setProxyTesting('llm')
    try {
      const message = await api.settings.testProxy('llm', trimmed)
      toast.show(`模型代理${message}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setProxyTesting(null)
    }
  }

  const changeScraper = async (name: string): Promise<void> => {
    const next = await api.settings.update({ defaultScraper: name })
    setSettings(next)
    toast.show(`默认影片刮削站点已设为 ${name}`, 'success')
  }

  const changeActressScraper = async (name: string): Promise<void> => {
    const next = await api.settings.update({ defaultActressScraper: name })
    setSettings(next)
    toast.show(`默认演员刮削站点已设为 ${name}`, 'success')
  }

  const importPlugin = async (): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy('import')
    try {
      const plugin = await api.plugins.importPlugin()
      if (!plugin) return
      if (plugin.kind === 'video') await refreshVideoPlugins()
      else await refreshActressPlugins()
      const kindLabel = plugin.kind === 'video' ? '影片' : '演员'
      toast.show(`已导入${kindLabel}刮削插件：${plugin.name}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const exportVideoPlugin = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`video-export:${name}`)
    try {
      const target = await api.scrape.exportPlugin(name)
      if (target) toast.show('影片刮削插件已导出', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const loadVideoPluginForAiDebug = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`load-video:${name}`)
    try {
      setDevLoadPackage(await api.scrape.getPluginPackage(name))
      navigate('/settings/plugin-dev')
      toast.show(`已载入影片插件：${name}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const exportActressPlugin = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`actress-export:${name}`)
    try {
      const target = await api.actressScrape.exportPlugin(name)
      if (target) toast.show('演员刮削插件已导出', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const loadActressPluginForAiDebug = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`load-actress:${name}`)
    try {
      setDevLoadPackage(await api.actressScrape.getPluginPackage(name))
      navigate('/settings/plugin-dev')
      toast.show(`已载入演员插件：${name}`, 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const deleteVideoPlugin = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`video-delete:${name}`)
    try {
      await api.scrape.deletePlugin(name)
      await refreshVideoPlugins()
      setSettings(await api.settings.get())
      toast.show('影片刮削插件已删除', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const deleteVideoComposite = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`video-composite-delete:${name}`)
    try {
      await api.scrape.deleteComposite(name)
      await refreshVideoPlugins()
      setSettings(await api.settings.get())
      toast.show('影片组合插件已删除', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const deleteActressPlugin = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`actress-delete:${name}`)
    try {
      await api.actressScrape.deletePlugin(name)
      await refreshActressPlugins()
      setSettings(await api.settings.get())
      toast.show('演员刮削插件已删除', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const deleteActressComposite = async (name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`actress-composite-delete:${name}`)
    try {
      await api.actressScrape.deleteComposite(name)
      await refreshActressPlugins()
      setSettings(await api.settings.get())
      toast.show('演员组合插件已删除', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const confirmPluginDelete = async (): Promise<void> => {
    if (!pluginDeleteTarget || pluginBusy) return
    const { kind, name, composite } = pluginDeleteTarget
    setPluginDeleteTarget(null)
    if (composite) {
      if (kind === 'video') await deleteVideoComposite(name)
      else await deleteActressComposite(name)
      return
    }
    if (kind === 'video') await deleteVideoPlugin(name)
    else await deleteActressPlugin(name)
  }

  const refreshPluginsForKind = async (kind: PluginKind): Promise<void> => {
    if (kind === 'video') await refreshVideoPlugins()
    else await refreshActressPlugins()
  }

  const savePluginConfig = async (
    kind: PluginKind,
    name: string,
    input: ScraperPluginUpdateInput
  ): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`${kind}-update:${name}`)
    try {
      if (kind === 'video') await api.scrape.updatePlugin(name, input)
      else await api.actressScrape.updatePlugin(name, input)
      await refreshPluginsForKind(kind)
      setEditingPlugin(null)
      toast.show('插件配置已保存', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const saveCompositePlugin = async (
    kind: PluginKind,
    originalName: string | null,
    input: CompositeScraperInput
  ): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`${kind}-composite:${originalName ?? input.name}`)
    try {
      if (kind === 'video') {
        if (originalName) await api.scrape.updateComposite(originalName, input)
        else await api.scrape.createComposite(input)
      } else {
        if (originalName) await api.actressScrape.updateComposite(originalName, input)
        else await api.actressScrape.createComposite(input)
      }
      await refreshPluginsForKind(kind)
      setEditingComposite(null)
      toast.show(originalName ? '组合插件已更新' : '组合插件已创建', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const changeTheme = async (id: ThemeId): Promise<void> => {
    await setTheme(id)
    setSettings((s) => (s ? { ...s, theme: id } : s))
  }

  const patchLibrarySettings = async (
    patch: Partial<Pick<AppSettings, 'minScanImportDurationMinutes'>>
  ): Promise<void> => {
    if (!settings) return
    try {
      const next = await api.settings.update(patch)
      setSettings(next)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const patchAppearanceSettings = async (
    patch: Partial<
      Pick<
        AppSettings,
        | 'videoDetailUseFirstSampleBackground'
        | 'actressDetailUseFirstGalleryBackground'
      >
    >
  ): Promise<void> => {
    if (!settings) return
    try {
      const next = await api.settings.update(patch)
      setSettings(next)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
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

  const runScan = async (): Promise<void> => {
    if (!settings.libraryPaths.length) {
      toast.show('请先添加媒体库路径', 'error')
      return
    }
    setScanning(true)
    setScanResult(null)
    setScanStatus('扫描中…')
    try {
      const res = await api.scan.run()
      setScanResult(res)
      setUnrecognized(res.unrecognizedFiles)
      setScanStatus('')
      if (res.cancelled) {
        toast.show(
          `扫描已取消：已扫描 ${res.scannedFiles} 个文件，新增 ${res.imported} 部`,
          'info'
        )
      } else {
        toast.show(
          `扫描完成：新增 ${res.imported} 部，路径更新 ${res.relocated} 部，移除 ${res.removed} 部，跳过 ${res.skipped} 部`,
          'success'
        )
      }
      invalidateAllLibraryQueries(queryClient)
      setOverviewStatsRefreshKey((key) => key + 1)
      if (!res.cancelled && res.imported > 0) {
        try {
          const stats = await api.settings.getOverviewStats()
          if (
            stats.videos.unscraped > 0 &&
            !sessionStorage.getItem(MAINTENANCE_HINT_KEYS.scanScrapePrompt)
          ) {
            setScanScrapePrompt({ imported: res.imported, unscraped: stats.videos.unscraped })
          } else {
            setScanScrapePrompt(null)
          }
        } catch {
          /* ignore stats fetch errors */
        }
      } else {
        setScanScrapePrompt(null)
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
      setScanStatus('')
    } finally {
      setScanning(false)
    }
  }

  const cancelScan = async (): Promise<void> => {
    try {
      const cancelled = await api.scan.cancel()
      if (cancelled) {
        setScanStatus('正在取消扫描…')
      }
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const handleResolved = (oldPath: string): void => {
    setUnrecognized((prev) => prev.filter((p) => p !== oldPath))
  }

  const dismissScanScrapePrompt = (): void => {
    dismissMaintenanceHint(MAINTENANCE_HINT_KEYS.scanScrapePrompt)
    setScanScrapePrompt(null)
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
    scrapeStatus: ActressBatchScrapeStatus = 'unscraped'
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
        useAliases
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

  const cancelVideoBatch = async (): Promise<void> => {
    try {
      await api.batchScrape.pause()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const cancelActressBatch = async (): Promise<void> => {
    try {
      await api.batchScrape.pause()
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const resumeBatch = async (): Promise<void> => {
    try {
      await api.batchScrape.resume()
      toast.show('已继续批量刮削', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const discardBatch = async (_kind: 'video' | 'actress'): Promise<void> => {
    try {
      await api.batchScrape.discard()
      toast.show('已终止批量刮削任务', 'success')
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const navigateSettings = (group: SettingsGroup, tab?: SettingsTab): void => {
    navigate(settingsPath(group, tab))
  }

  const videoUserPlugins = videoPluginDetails.filter((plugin) => plugin.source !== 'composite')
  const actressUserPlugins = actressPluginDetails.filter((plugin) => plugin.source !== 'composite')
  const videoCompositePlugins = videoPluginDetails.filter((plugin) => plugin.source === 'composite')
  const actressCompositePlugins = actressPluginDetails.filter((plugin) => plugin.source === 'composite')
  const defaultVideoPlugin = videoPluginDetails.find((plugin) => plugin.name === settings.defaultScraper)
  const defaultActressPlugin = actressPluginDetails.find(
    (plugin) => plugin.name === settings.defaultActressScraper
  )
  const pluginTotal = videoPluginDetails.length + actressPluginDetails.length
  const unrecognizedCount = unrecognized.length
  const videoBatchRunning = videoBatch?.status === 'running'
  const actressBatchRunning = actressBatch?.status === 'running'
  const videoBatchPaused = videoBatch?.status === 'paused'
  const actressBatchPaused = actressBatch?.status === 'paused'
  const anyBatchActive =
    videoBatchRunning || actressBatchRunning || videoBatchPaused || actressBatchPaused
  const batchPercent = (batch: BatchProgress | null): number =>
    batch && batch.total > 0 ? Math.round((batch.current / batch.total) * 100) : 0
  const videoBatchPct = batchPercent(videoBatch)
  const actressPct = batchPercent(actressBatch)
  const overviewNotices = [
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

  if (isPluginDevPage) {
    return (
      <div className="scroll-body scroll-body--fill">
        <div className="scroll-body-inner scroll-body-inner--settings settings-dev-page">
          <PluginDevPanel
            settings={settings}
            setSettings={setSettings}
            loadPackage={devLoadPackage}
            onLoadConsumed={() => setDevLoadPackage(null)}
            onInstalled={async (kind) => {
              await refreshPluginsForKind(kind)
              setSettings(await api.settings.get())
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="scroll-body scroll-body--fill">
      <div className="scroll-body-inner scroll-body-inner--settings settings-overview-page">
        <nav className="settings-group-tabs" aria-label="设置分类">
          {SETTINGS_GROUPS.map((group) => (
            <button
              key={group.id}
              type="button"
              className={`settings-group-tab${
                activeGroup.id === group.id ? ' is-active' : ''
              }`}
              aria-current={activeGroup.id === group.id ? 'page' : undefined}
              onClick={() => navigateSettings(group.id)}
            >
              {group.label}
            </button>
          ))}
        </nav>

        <div className="settings-scroll-region">
          <main
            id="settings-main-panel"
            className="settings-content"
            role="region"
            aria-label={`${activeGroup.label}设置`}
          >
            {activeGroup.tabs.length > 1 && activeGroup.id !== 'batch' && (
              <SettingsTabBar
                group={activeGroup.id}
                tabs={activeGroup.tabs}
                activeTab={activeTab}
                label={`${activeGroup.label}设置页签`}
                onSelect={(tab) => navigateSettings(activeGroup.id, tab)}
                onKeyDown={onSettingsTabKeyDown}
              />
            )}

            <section
              className="settings-section"
              role="tabpanel"
              id={settingsTabPanelDomId(activeGroup.id, activeTab)}
              aria-labelledby={
                activeGroup.tabs.length > 1
                  ? settingsTabDomId(activeGroup.id, activeTab)
                  : undefined
              }
              aria-label={activeGroup.tabs.length === 1 ? activeGroup.label : undefined}
            >
              {activeGroup.id === 'overview' && (
                <SettingsOverviewPanel
                  settings={settings}
                  theme={theme}
                  themeLabel={THEME_OPTIONS.find((item) => item.id === theme)?.label ?? theme}
                  notices={overviewNotices}
                  videoBatch={videoBatch}
                  actressBatch={actressBatch}
                  anyBatchActive={anyBatchActive}
                  videoBatchPct={videoBatchPct}
                  actressPct={actressPct}
                  unrecognizedCount={unrecognizedCount}
                  statsRefreshKey={overviewStatsRefreshKey}
                  onNavigate={navigateSettings}
                  onNavigateLibraryUnrecognized={() =>
                    navigate(settingsPath('library'), { state: { libraryFocus: 'unrecognized' } })
                  }
                  onOpenAgentTool={(toolId) => {
                    if (toolId === 'plugin-dev') navigate('/settings/plugin-dev')
                  }}
                  onStartVideoBatchDefault={startVideoBatchDefault}
                  onStartActressBatchDefault={startActressBatchDefault}
                  onOpenVideoBatchAdvanced={() => setShowVideoBatchModal(true)}
                  onOpenActressBatchAdvanced={() => setShowActressBatchModal(true)}
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
                  onRequestRemovePath={setPathRemoveTarget}
                  onResolvedUnrecognized={handleResolved}
                  onPatchSettings={(patch) => void patchLibrarySettings(patch)}
                  scanScrapePrompt={scanScrapePrompt}
                  videoBatchActive={anyBatchActive}
                  defaultScraper={settings.defaultScraper}
                  onDismissScanScrapePrompt={dismissScanScrapePrompt}
                  onStartScanScrapeBatch={startVideoBatchDefault}
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
                  onOpenDev={() => navigate('/settings/plugin-dev')}
                  onEdit={(kind, plugin) => {
                    if (plugin.source === 'composite') {
                      setEditingComposite({ kind, plugin })
                      return
                    }
                    setEditingPlugin({ kind, plugin })
                  }}
                  onExport={(kind, name) =>
                    kind === 'video' ? void exportVideoPlugin(name) : void exportActressPlugin(name)
                  }
                  onAiDebug={(kind, name) =>
                    kind === 'video'
                      ? void loadVideoPluginForAiDebug(name)
                      : void loadActressPluginForAiDebug(name)
                  }
                  onRequestDelete={setPluginDeleteTarget}
                  onSetDefault={(kind, name) =>
                    kind === 'video' ? void changeScraper(name) : void changeActressScraper(name)
                  }
                  onCreateComposite={(kind) => setEditingComposite({ kind })}
                />
              )}

              {activeGroup.id === 'batch' && (
                <BatchSettingsPanel
                  scope={activeTab === 'actress' ? 'actress' : 'video'}
                  onScopeChange={(scope) => navigateSettings('batch', scope)}
                  title={activeTab === 'actress' ? '批量刮削（演员）' : '批量更新（影片）'}
                  hint={
                    activeTab === 'actress'
                      ? '按演员范围和缺失字段筛选目标，再选择本次更新字段。'
                      : '合并批量刮削与修正匹配；范围可按刮削状态、缺失字段收窄。'
                  }
                  batch={activeTab === 'actress' ? actressBatch : videoBatch}
                  percent={activeTab === 'actress' ? actressPct : videoBatchPct}
                  running={activeTab === 'actress' ? actressBatchRunning : videoBatchRunning}
                  paused={activeTab === 'actress' ? actressBatchPaused : videoBatchPaused}
                  anyBatchActive={anyBatchActive}
                  logRef={activeTab === 'actress' ? actressLogRef : videoBatchLogRef}
                  emptyLog={activeTab === 'actress' ? '暂无演员任务日志' : '暂无影片任务日志'}
                  onConfigure={() =>
                    activeTab === 'actress'
                      ? setShowActressBatchModal(true)
                      : setShowVideoBatchModal(true)
                  }
                  onPause={() =>
                    activeTab === 'actress' ? void cancelActressBatch() : void cancelVideoBatch()
                  }
                  onResume={() => void resumeBatch()}
                  onDiscard={() => void discardBatch(activeTab === 'actress' ? 'actress' : 'video')}
                  onTabKeyDown={onSettingsTabKeyDown}
                />
              )}

              {activeGroup.id === 'appearance' && activeTab === 'theme' && (
                <AppearanceSettingsPanel
                  settings={settings}
                  theme={theme}
                  onThemeChange={changeTheme}
                  onPatchSettings={(patch) => void patchAppearanceSettings(patch)}
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
            </section>
          </main>
        </div>

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
          onScopeChange={(status, missingFields) =>
            void refreshVideoBatchScopeHint(status, missingFields)
          }
          missingFieldOptions={VIDEO_SCRAPE_FIELD_OPTIONS}
          missingFieldHint="选择后包含缺少任一所选字段的影片。"
          onMissingFieldsChange={(missingFields, status) => {
            if (status !== undefined) void refreshVideoBatchScopeHint(status, missingFields)
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
          onMissingFieldsChange={(missingFields, scope, scrapeStatus) => {
            if (scope !== undefined) {
              void refreshActressBatchScopeHint(scope, missingFields, scrapeStatus ?? 'unscraped')
            }
          }}
          onCancel={() => setShowActressBatchModal(false)}
          onConfirm={(fields, site, scope, mode, missingFields, _matchName, useAliases, scrapeStatus) => {
            if (scope !== undefined) {
              void startActressBatch(
                fields,
                site,
                scope,
                mode as ActressScrapeUpdateMode,
                missingFields ?? [],
                useAliases,
                scrapeStatus ?? 'unscraped'
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
      {pathRemoveTarget && (
        <ConfirmModal
          title="移除媒体库路径"
          confirmText="移除"
          danger
          onCancel={() => setPathRemoveTarget(null)}
          onConfirm={() => void confirmRemovePath()}
        >
          <p>确定从媒体库中移除以下路径？</p>
          <div className="modal-path-text">{pathRemoveTarget}</div>
          <p className="modal-field-hint">不会删除磁盘上的文件，仅停止扫描该路径。</p>
        </ConfirmModal>
      )}
      {pluginDeleteTarget && (
        <ConfirmModal
          title={pluginDeleteTarget.composite ? '删除组合插件' : '删除插件'}
          confirmText={pluginBusy ? '删除中…' : '删除'}
          danger
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
      </div>
    </div>
  )
}
