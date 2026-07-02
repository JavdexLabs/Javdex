import type { ScrapeResult } from '@shared/types'

/**
 * Plugin contract for a metadata scraper. Implementations parse a remote
 * source for a given code and return structured data (or null when not found).
 */
export interface BaseScraper {
  /** Unique, human-readable plugin name (e.g. "JavDB"). */
  scraperName: string
  /**
   * Resolve metadata for a code. Network requests should honour proxyUrl
   * when provided. Returns null when the title cannot be found.
   */
  parseTask(code: string, proxyUrl?: string): Promise<ScrapeResult | null>
}
