import type { ScraperPluginKind } from '@shared/scraperPluginTypes'
import { scraperPluginPreLoginHomeUrl } from '@shared/scraperPluginPreLogin'
import { scrapeBrowser } from './scrapeBrowser'
import { listMergedPluginDescriptors } from './scraperPluginService'

export interface ScraperPreLoginWaitEvent {
  kind: ScraperPluginKind
  pluginName: string
}

export interface ScraperPreLoginSession {
  ensure(kind: ScraperPluginKind, pluginName: string, proxyUrl?: string): Promise<void>
}

export function createScraperPreLoginSession(options?: {
  onWaiting?: (event: ScraperPreLoginWaitEvent) => void
  waitForHomepage?: (input: {
    url: string
    pluginName: string
    proxyUrl?: string
  }) => Promise<void>
}): ScraperPreLoginSession {
  const completed = new Set<string>()
  const inflight = new Map<string, Promise<void>>()
  const waitForHomepage =
    options?.waitForHomepage ??
    (async (input) => {
      await scrapeBrowser.setProxy(input.proxyUrl)
      await scrapeBrowser.waitPreLogin(input.url, input.pluginName)
    })

  return {
    async ensure(kind, pluginName, proxyUrl) {
      const key = `${kind}:${pluginName}`
      if (completed.has(key)) return
      const pending = inflight.get(key)
      if (pending) return pending
      const plugin = listMergedPluginDescriptors(kind).find((item) => item.name === pluginName)
      if (!plugin?.preLogin) return
      const url = scraperPluginPreLoginHomeUrl(plugin.homepage)
      if (!url) return
      options?.onWaiting?.({ kind, pluginName })
      const task = (async () => {
        try {
          await waitForHomepage({ url, pluginName, proxyUrl })
          completed.add(key)
        } finally {
          inflight.delete(key)
        }
      })()
      inflight.set(key, task)
      return task
    }
  }
}
