import { ALL_ACTRESS_SCRAPE_FIELDS, type ActressBatchScrapeScope } from '@shared/actressScrapeTypes'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import { api } from '../api'
import { withVideoBatchRequestScope } from './videoBatchScope'

export async function startDefaultUnscrapedVideoBatch(
  scraperName: string,
  libraryId: number
): Promise<void> {
  await api.scrape.videoBatchStart(
    withVideoBatchRequestScope(
      { kind: 'library', libraryId },
      {
        fields: ALL_VIDEO_SCRAPE_FIELDS,
        scraperName: scraperName || undefined,
        status: 0,
        mode: 'fillEmpty',
        missingFields: []
      }
    )
  )
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
