import type { CatalogBackend } from '../application/catalogBackend'
import { scrapeActress, type ScrapeActressOptions } from '../scrapers/actressScraperManager'
import {
  scrapeVideo,
  type ScrapeOutcome,
  type ScrapeVideoOptions
} from '../scrapers/scraperManager'
import { scrapeActressThroughCatalog, scrapeVideoThroughCatalog } from './catalogRemoteScrape'
import type { ActressScrapeDisposition } from '@shared/actressScrapeTypes'

let catalog: CatalogBackend | null = null

export function bindScrapeCatalog(backend: CatalogBackend | null): void {
  catalog = backend?.mode === 'remote' ? backend : null
}

export function scrapeCatalog(): CatalogBackend | null {
  return catalog
}

export function scrapeVideoBound(
  videoId: number,
  scraperName?: string,
  options?: ScrapeVideoOptions
): Promise<ScrapeOutcome> {
  return catalog
    ? scrapeVideoThroughCatalog(catalog, videoId, scraperName, options)
    : scrapeVideo(videoId, scraperName, options)
}

export function scrapeActressBound(
  actressId: number,
  scraperName?: string,
  options?: ScrapeActressOptions
): Promise<ActressScrapeDisposition> {
  return catalog
    ? scrapeActressThroughCatalog(catalog, actressId, scraperName, options)
    : scrapeActress(actressId, scraperName, options)
}
