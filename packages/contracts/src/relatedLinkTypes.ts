import type { z } from 'zod'
import type { relatedLinkSchema } from './catalogDetailSchemas'
export interface RelatedLinkInput {
  label: string
  url: string
}

export type RelatedLink = z.infer<typeof relatedLinkSchema>
