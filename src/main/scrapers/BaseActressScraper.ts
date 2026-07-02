import type { ActressScrapeResult } from '@shared/types'

/** Plugin contract for actress-profile scrapers (separate from video scrapers). */
export interface BaseActressScraper {
  scraperName: string
  /**
   * Resolve profile metadata for an actress name (plus known aliases).
   * Returns null when no profile is found.
   */
  parseTask(
    mainName: string,
    aliases: string[],
    proxyUrl?: string
  ): Promise<ActressScrapeResult | null>
}
