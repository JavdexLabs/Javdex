import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings } from '@shared/types'
import { api } from '../api'
import { useToast } from '../components/Toast'

export default function useNetworkSettingsController(
  settings: AppSettings | null,
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
): {
  scrapeProxyDraft: string
  llmProxyDraft: string
  proxySaving: 'scrape' | 'llm' | null
  proxyTesting: 'scrape' | 'llm' | null
  proxyToggleBusy: 'scrape' | 'llm' | null
  setScrapeProxyDraft: Dispatch<SetStateAction<string>>
  setLlmProxyDraft: Dispatch<SetStateAction<string>>
  toggleScrapeProxyEnabled: (enabled: boolean) => Promise<void>
  toggleLlmProxyEnabled: (enabled: boolean) => Promise<void>
  saveScrapeProxyUrl: (proxyUrl: string) => Promise<boolean>
  saveLlmProxyUrl: (proxyUrl: string) => Promise<boolean>
  testScrapeProxy: (proxyUrl: string) => Promise<void>
  testLlmProxy: (proxyUrl: string) => Promise<void>
} {
  const toast = useToast()
  const [scrapeProxyDraft, setScrapeProxyDraft] = useState('')
  const [llmProxyDraft, setLlmProxyDraft] = useState('')
  const [proxySaving, setProxySaving] = useState<'scrape' | 'llm' | null>(null)
  const [proxyTesting, setProxyTesting] = useState<'scrape' | 'llm' | null>(null)
  const [proxyToggleBusy, setProxyToggleBusy] = useState<'scrape' | 'llm' | null>(null)

  useEffect(() => {
    if (!settings) return
    setScrapeProxyDraft(settings.proxyUrl)
  }, [settings?.proxyUrl])

  useEffect(() => {
    if (!settings) return
    setLlmProxyDraft(settings.llmProxyUrl)
  }, [settings?.llmProxyUrl])

  const toggleProxyEnabled = async (kind: 'scrape' | 'llm', enabled: boolean): Promise<void> => {
    if (!settings || proxyToggleBusy) return
    const draft = kind === 'scrape' ? scrapeProxyDraft.trim() : llmProxyDraft.trim()
    const label = kind === 'scrape' ? '刮削' : '模型'
    if (enabled && !draft) {
      toast.show(`请先填写${label}代理地址`, 'error')
      return
    }

    setProxyToggleBusy(kind)
    try {
      const patch: Partial<AppSettings> =
        kind === 'scrape' ? { proxyUrlEnabled: enabled } : { llmProxyUrlEnabled: enabled }
      if (enabled && kind === 'scrape' && draft !== settings.proxyUrl) patch.proxyUrl = draft
      if (enabled && kind === 'llm' && draft !== settings.llmProxyUrl) patch.llmProxyUrl = draft
      setSettings(await api.settings.update(patch))
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      setProxyToggleBusy(null)
    }
  }

  const saveProxyUrl = async (kind: 'scrape' | 'llm', value: string): Promise<boolean> => {
    if (!settings || proxySaving) return false
    const trimmed = value.trim()
    const enabled = kind === 'scrape' ? settings.proxyUrlEnabled : settings.llmProxyUrlEnabled
    const current = kind === 'scrape' ? settings.proxyUrl : settings.llmProxyUrl
    const label = kind === 'scrape' ? '刮削' : '模型'
    if (enabled && !trimmed) {
      toast.show(`${label}代理已启用，请填写代理地址`, 'error')
      return false
    }
    if (trimmed === current) return true

    setProxySaving(kind)
    try {
      const next = await api.settings.update(
        kind === 'scrape' ? { proxyUrl: trimmed } : { llmProxyUrl: trimmed }
      )
      setSettings(next)
      toast.show(`${label}代理地址已保存`, 'success')
      return true
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
      return false
    } finally {
      setProxySaving(null)
    }
  }

  const testProxy = async (kind: 'scrape' | 'llm', value: string): Promise<void> => {
    if (proxyTesting) return
    const trimmed = value.trim()
    if (!trimmed) {
      toast.show('请填写代理地址', 'error')
      return
    }
    setProxyTesting(kind)
    try {
      const message = await api.settings.testProxy(kind, trimmed)
      toast.show(`${kind === 'scrape' ? '刮削' : '模型'}代理${message}`, 'success')
    } catch (error) {
      toast.show(String((error as Error).message), 'error')
    } finally {
      setProxyTesting(null)
    }
  }

  return {
    scrapeProxyDraft,
    llmProxyDraft,
    proxySaving,
    proxyTesting,
    proxyToggleBusy,
    setScrapeProxyDraft,
    setLlmProxyDraft,
    toggleScrapeProxyEnabled: (enabled) => toggleProxyEnabled('scrape', enabled),
    toggleLlmProxyEnabled: (enabled) => toggleProxyEnabled('llm', enabled),
    saveScrapeProxyUrl: (value) => saveProxyUrl('scrape', value),
    saveLlmProxyUrl: (value) => saveProxyUrl('llm', value),
    testScrapeProxy: (value) => testProxy('scrape', value),
    testLlmProxy: (value) => testProxy('llm', value)
  }
}
