import type { CatalogBackend } from '../application/catalogBackend'
import { scrapeActress, type ScrapeActressOptions } from '../scrapers/actressScraperManager'
import {
  scrapeVideo,
  type ScrapeOutcome,
  type ScrapeVideoOptions
} from '../scrapers/scraperManager'
import { scrapeActressThroughCatalog, scrapeVideoThroughCatalog } from './catalogRemoteScrape'
import type { ActressScrapeDisposition } from '@shared/actressScrapeTypes'

/** Per-controller catalog-aware scrape operations; intentionally no global binding. */
export interface ScrapeCatalogBinding {
  readonly catalog: CatalogBackend | null
  scrapeVideo(
    videoId: number,
    scraperName?: string,
    options?: ScrapeVideoOptions
  ): Promise<ScrapeOutcome>
  scrapeActress(
    actressId: number,
    scraperName?: string,
    options?: ScrapeActressOptions
  ): Promise<ActressScrapeDisposition>
}

export function createScrapeCatalogBinding(backend?: CatalogBackend): ScrapeCatalogBinding {
  const catalog = backend?.mode === 'remote' ? backend : null
  return {
    catalog,
    scrapeVideo: (videoId, scraperName, options) =>
      catalog
        ? scrapeVideoThroughCatalog(catalog, videoId, scraperName, options)
        : scrapeVideo(videoId, scraperName, options),
    scrapeActress: (actressId, scraperName, options) =>
      catalog
        ? scrapeActressThroughCatalog(catalog, actressId, scraperName, options)
        : scrapeActress(actressId, scraperName, options)
  }
}
