import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { SettingsSnapshot } from '@shared/settingsTypes'
import type { ScraperPluginDescriptor, ScraperPluginPackage } from '@shared/scraperPluginTypes'
import type { PluginDeleteTarget } from '../components/settings/PluginsSettingsPanel'
import type {
  CompositeEditState,
  PluginEditState,
  PluginKind
} from '../components/settings/PluginConfigModals'
import type {
  CompositeScraperInput,
  ScraperPluginUpdateInput,
  ScraperServiceConfigInput,
  ScraperServiceConnectionResult
} from '@shared/scrapeTypes'
import { api } from '../api'
import { useToast } from '../components/Toast'

interface Options {
  shouldLoad: boolean
  openPluginDev: () => void
  setSettings: Dispatch<SetStateAction<SettingsSnapshot | null>>
}

export default function useScraperPluginSettingsController({
  shouldLoad,
  openPluginDev,
  setSettings
}: Options) {
  const toast = useToast()
  const [scrapers, setScrapers] = useState<string[]>([])
  const [actressScrapers, setActressScrapers] = useState<string[]>([])
  const [videoPluginDetails, setVideoPluginDetails] = useState<Awaited<ReturnType<typeof api.scrape.listPluginDetails>>>([])
  const [actressPluginDetails, setActressPluginDetails] = useState<Awaited<ReturnType<typeof api.actressScrape.listPluginDetails>>>([])
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const [editingPlugin, setEditingPlugin] = useState<PluginEditState | null>(null)
  const [editingComposite, setEditingComposite] = useState<CompositeEditState | null>(null)
  const [pluginDeleteTarget, setPluginDeleteTarget] = useState<PluginDeleteTarget | null>(null)
  const [devLoadPackage, setDevLoadPackage] = useState<ScraperPluginPackage | null>(null)

  const refreshVideoPlugins = useCallback(async (): Promise<void> => {
    const [names, details] = await Promise.all([
      api.scrape.listPlugins(),
      api.scrape.listPluginDetails()
    ])
    setScrapers(names)
    setVideoPluginDetails(details)
  }, [])

  const refreshActressPlugins = useCallback(async (): Promise<void> => {
    const [names, details] = await Promise.all([
      api.actressScrape.listPlugins(),
      api.actressScrape.listPluginDetails()
    ])
    setActressScrapers(names)
    setActressPluginDetails(details)
  }, [])

  const refreshPluginsForKind = useCallback(async (kind: PluginKind): Promise<void> => {
    if (kind === 'video') await refreshVideoPlugins()
    else await refreshActressPlugins()
  }, [refreshActressPlugins, refreshVideoPlugins])

  const openPluginEditor = async (
    kind: PluginKind,
    plugin: ScraperPluginDescriptor
  ): Promise<void> => {
    if (!plugin.requiresConfiguration) {
      setEditingPlugin({ kind, plugin })
      return
    }
    if (kind !== 'video' || plugin.name !== 'MetaTube' || pluginBusy) return
    setPluginBusy('video-service-load:MetaTube')
    try {
      const serviceConfig = await api.scrape.getServiceConfig('metatube')
      setEditingPlugin({ kind, plugin, serviceConfig })
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  useEffect(() => {
    if (!shouldLoad) return
    void Promise.all([refreshVideoPlugins(), refreshActressPlugins()]).catch((error) =>
      toast.show(String((error as Error).message ?? error), 'error')
    )
  }, [refreshActressPlugins, refreshVideoPlugins, shouldLoad, toast])

  const importPlugin = async (): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy('import')
    try {
      const plugin = await api.plugins.importPlugin()
      if (!plugin) return
      await refreshPluginsForKind(plugin.kind)
      const kindLabel = plugin.kind === 'video' ? '影片' : '演员'
      toast.show(`已导入${kindLabel}刮削插件：${plugin.name}`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const exportPlugin = async (kind: PluginKind, name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`${kind}-export:${name}`)
    try {
      const target = kind === 'video'
        ? await api.scrape.exportPlugin(name)
        : await api.actressScrape.exportPlugin(name)
      if (target) toast.show(`${kind === 'video' ? '影片' : '演员'}刮削插件已导出`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const loadPluginForAiDebug = async (kind: PluginKind, name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`load-${kind}:${name}`)
    try {
      const pluginPackage = kind === 'video'
        ? await api.scrape.getPluginPackage(name)
        : await api.actressScrape.getPluginPackage(name)
      setDevLoadPackage(pluginPackage)
      openPluginDev()
      toast.show(`已载入${kind === 'video' ? '影片' : '演员'}插件：${name}`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const deletePlugin = async (target: PluginDeleteTarget): Promise<void> => {
    const { kind, name, composite } = target
    setPluginBusy(`${kind}-${composite ? 'composite-' : ''}delete:${name}`)
    try {
      if (kind === 'video') {
        if (composite) await api.scrape.deleteComposite(name)
        else await api.scrape.deletePlugin(name)
      } else if (composite) {
        await api.actressScrape.deleteComposite(name)
      } else {
        await api.actressScrape.deletePlugin(name)
      }
      await refreshPluginsForKind(kind)
      setSettings(await api.settings.get())
      toast.show(`${kind === 'video' ? '影片' : '演员'}${composite ? '组合' : '刮削'}插件已删除`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const confirmPluginDelete = async (): Promise<void> => {
    if (!pluginDeleteTarget || pluginBusy) return
    const target = pluginDeleteTarget
    setPluginDeleteTarget(null)
    await deletePlugin(target)
  }

  const savePluginConfig = async (
    kind: PluginKind,
    name: string,
    input: ScraperPluginUpdateInput,
    serviceInput?: ScraperServiceConfigInput
  ): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`${kind}-update:${name}`)
    try {
      if (serviceInput) await api.scrape.saveServiceConfig('metatube', serviceInput)
      if (kind === 'video') await api.scrape.updatePlugin(name, input)
      else await api.actressScrape.updatePlugin(name, input)
      await refreshPluginsForKind(kind)
      if (serviceInput) setSettings(await api.settings.get())
      setEditingPlugin(null)
      toast.show('插件配置已保存', 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const testPluginServiceConfig = (
    input: ScraperServiceConfigInput
  ): Promise<ScraperServiceConnectionResult> => {
    return api.scrape.testServiceConfig('metatube', input)
  }

  const clearPluginServiceConfig = async (): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy('video-service-clear:MetaTube')
    try {
      await api.scrape.clearServiceConfig('metatube')
      await refreshVideoPlugins()
      setSettings(await api.settings.get())
      setEditingPlugin(null)
      toast.show('MetaTube 服务配置已清除', 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
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
      } else if (originalName) {
        await api.actressScrape.updateComposite(originalName, input)
      } else {
        await api.actressScrape.createComposite(input)
      }
      await refreshPluginsForKind(kind)
      setEditingComposite(null)
      toast.show(originalName ? '组合插件已更新' : '组合插件已创建', 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const changeDefaultPlugin = async (kind: PluginKind, name: string): Promise<void> => {
    if (pluginBusy) return
    setPluginBusy(`${kind}-default`)
    try {
      const next = await api.settings.update(
        kind === 'video' ? { defaultScraper: name } : { defaultActressScraper: name }
      )
      setSettings(next)
      toast.show(`默认${kind === 'video' ? '影片' : '演员'}刮削站点已设为 ${name}`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message ?? error), 'error')
    } finally {
      setPluginBusy(null)
    }
  }

  const handleInstalled = async (kind: PluginKind): Promise<void> => {
    await refreshPluginsForKind(kind)
    setSettings(await api.settings.get())
  }

  const pluginGroups = useMemo(() => ({
    videoUserPlugins: videoPluginDetails.filter((plugin) => plugin.source !== 'composite'),
    actressUserPlugins: actressPluginDetails.filter((plugin) => plugin.source !== 'composite'),
    videoCompositePlugins: videoPluginDetails.filter((plugin) => plugin.source === 'composite'),
    actressCompositePlugins: actressPluginDetails.filter((plugin) => plugin.source === 'composite')
  }), [actressPluginDetails, videoPluginDetails])

  return {
    scrapers,
    actressScrapers,
    videoPluginDetails,
    actressPluginDetails,
    pluginBusy,
    editingPlugin,
    setEditingPlugin,
    openPluginEditor,
    editingComposite,
    setEditingComposite,
    pluginDeleteTarget,
    setPluginDeleteTarget,
    devLoadPackage,
    clearDevLoadPackage: () => setDevLoadPackage(null),
    importPlugin,
    exportPlugin,
    loadPluginForAiDebug,
    confirmPluginDelete,
    savePluginConfig,
    testPluginServiceConfig,
    clearPluginServiceConfig,
    saveCompositePlugin,
    changeDefaultPlugin,
    handleInstalled,
    ...pluginGroups
  }
}
