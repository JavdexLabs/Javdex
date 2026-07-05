import {
  ALL_ACTRESS_SCRAPE_FIELDS,
  ALL_VIDEO_SCRAPE_FIELDS,
  type ActressBatchScrapeScope
} from '@shared/types'
import { api } from '../api'

export async function startDefaultUnscrapedVideoBatch(scraperName: string): Promise<void> {
  await api.scrape.videoBatchStart({
    fields: ALL_VIDEO_SCRAPE_FIELDS,
    scraperName: scraperName || undefined,
    status: 0,
    mode: 'fillEmpty',
    missingFields: []
  })
}

export async function startDefaultUnscrapedActressBatch(
  scraperName: string,
  scope: ActressBatchScrapeScope = 'female'
): Promise<void> {
  await api.actressScrape.batchStart({
    fields: ALL_ACTRESS_SCRAPE_FIELDS,
    scraperName: scraperName || undefined,
    scope,
    scrapeStatus: 'unscraped',
    missingFields: [],
    mode: 'fillEmpty',
    useAliases: false
  })
}
