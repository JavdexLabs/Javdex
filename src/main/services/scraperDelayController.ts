import type { ScraperPluginKind } from '@shared/types'
import { getSettings } from '../settings/settingsStore'

export interface ScraperDelayWaitEvent {
  kind: ScraperPluginKind
  pluginName: string
  waitMs: number
}

export interface ScraperDelayControllerOptions {
  onWait?: (event: ScraperDelayWaitEvent) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export class ScraperDelayController {
  private readonly nextAllowedAt = new Map<string, number>()
  private readonly onWait?: (event: ScraperDelayWaitEvent) => void
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(options: ScraperDelayControllerOptions = {}) {
    this.onWait = options.onWait
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

  async run<T>(
    kind: ScraperPluginKind,
    pluginName: string,
    task: () => Promise<T>
  ): Promise<T> {
    await this.waitUntilAllowed(kind, pluginName)
    try {
      return await task()
    } finally {
      this.scheduleNextAccess(kind, pluginName)
    }
  }

  private async waitUntilAllowed(kind: ScraperPluginKind, pluginName: string): Promise<void> {
    const key = `${kind}:${pluginName}`
    const now = this.now()
    const waitMs = Math.max(0, (this.nextAllowedAt.get(key) ?? 0) - now)
    if (waitMs > 0) {
      this.onWait?.({ kind, pluginName, waitMs })
      await this.sleep(waitMs)
    }
  }

  private scheduleNextAccess(kind: ScraperPluginKind, pluginName: string): void {
    const key = `${kind}:${pluginName}`
    const delay = this.randomDelay(kind, pluginName)
    this.nextAllowedAt.set(key, this.now() + delay)
  }

  private randomDelay(kind: ScraperPluginKind, pluginName: string): number {
    const settings = getSettings()
    const configured = settings.scraperPluginDelays[kind][pluginName]
    const min = Math.max(0, configured?.minMs ?? settings.batchDelayMinMs)
    const max = Math.max(min, configured?.maxMs ?? settings.batchDelayMaxMs)
    return Math.floor(min + this.random() * (max - min))
  }
}
