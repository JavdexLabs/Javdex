import type { VideoScrapeTranslation } from '@shared/videoScrapeTypes'
import type { createMetadataTranslationTasks } from './metadataTranslationTasks'
import type { CatalogBackend } from '../application/catalogBackend'
import { scrapeActress, type ScrapeActressOptions } from '../scrapers/actressScraperManager'
import {
  scrapeVideo,
  type ScrapeOutcome,
  type ScrapeVideoOptions
} from '../scrapers/scraperManager'
import { scrapeActressThroughCatalog, scrapeVideoThroughCatalog } from './catalogRemoteScrape'
import type { ActressScrapeDisposition } from '@shared/actressScrapeTypes'

export type ScrapeTranslationService = ReturnType<typeof createMetadataTranslationTasks>['scrape']

/** Per-controller catalog-aware scrape operations; intentionally no global binding. */
export interface ScrapeCatalogBinding {
  readonly catalog: CatalogBackend | null
  scrapeVideo(
    videoId: number,
    scraperName?: string,
    options?: ScrapeVideoOptions & { translation?: VideoScrapeTranslation; libraryId?: number }
  ): Promise<ScrapeOutcome>
  scrapeActress(
    actressId: number,
    scraperName?: string,
    options?: ScrapeActressOptions
  ): Promise<ActressScrapeDisposition>
}

export function createScrapeCatalogBinding(backend?: CatalogBackend, translations?: ScrapeTranslationService): ScrapeCatalogBinding {
  const catalog = backend?.mode === 'remote' ? backend : null
  return {
    catalog,
    scrapeVideo: async (videoId, scraperName, { translation, libraryId, ...options } = {}) => {
      const scope = translation ? translations?.scope() : null
      const outcome = catalog
        ? await scrapeVideoThroughCatalog(catalog, videoId, scraperName, options)
        : await scrapeVideo(videoId, scraperName, options)
      if (outcome.ok && translation && translations) {
        await translations.afterWrite(scope ?? null, videoId, libraryId, translation, outcome)
      }
      return outcome
    },
    scrapeActress: (actressId, scraperName, options) =>
      catalog
        ? scrapeActressThroughCatalog(catalog, actressId, scraperName, options)
        : scrapeActress(actressId, scraperName, options)
  }
}
