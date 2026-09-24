import { randomUUID } from 'node:crypto'
import { resolveScrapeProxyUrl } from '@shared/settingsTypes'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'
import { getSettings } from '../settings/settingsStore'

/** Owns the user-visible scrape run and its browser lease. Conflicts fail immediately. */
class ScrapeRunCoordinator {
  private activeLabel: string | null = null

  isRunning(): boolean {
    return this.activeLabel !== null
  }

  getActiveLabel(): string | null {
    return this.activeLabel
  }

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeLabel) {
      throw new Error(`${this.activeLabel}进行中，请稍后再试`)
    }

    this.activeLabel = label
    const controller = new AbortController()
    try {
      const lease = await scrapeBrowser.acquire({
        ownerId: `scrape:${randomUUID()}`,
        purpose: 'scrape',
        proxyUrl: resolveScrapeProxyUrl(getSettings()),
        signal: controller.signal
      })
      try {
        return await scrapeBrowser.runWithLease(lease, fn)
      } finally {
        await lease.release()
      }
    } finally {
      this.activeLabel = null
    }
  }
}

export const scrapeRunCoordinator = new ScrapeRunCoordinator()
