import type { ManageOperationInput } from '@shared/manage/inputs'
import type { VideoScrapeField } from '@shared/videoScrapeTypes'
import type { ActressScrapeField } from '@shared/actressScrapeTypes'
import { resolveEffectiveVideoScrapeFields } from './videoScrapeApplyService'
import { resolveEffectiveActressScrapeFields } from './actressAssetService'

/** Use the same field and image facts as local scraping, on the authoritative host. */
export function resolveCatalogScrapeFields(input: ManageOperationInput<'scrape.fields'>): {
  fields: Array<VideoScrapeField | ActressScrapeField>
} {
  return {
    fields: input.kind === 'video'
      ? resolveEffectiveVideoScrapeFields(
          input.id, input.fields as VideoScrapeField[], 'fillEmpty',
          input.sourceName, input.ratingSourceName
        )
      : resolveEffectiveActressScrapeFields(
          input.id, input.fields as ActressScrapeField[], 'fillEmpty'
        )
  }
}
