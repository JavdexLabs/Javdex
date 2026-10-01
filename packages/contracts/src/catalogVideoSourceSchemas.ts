import { z } from 'zod'

export const catalogVideoSourceEntrySchema = z.object({
  source: z.string(),
  externalCode: z.string().nullable(),
  url: z.string().nullable()
})

export const catalogVideoSourceItemSchema = z.object({
  videoId: z.number().int().positive(),
  code: z.string(),
  sources: z.array(catalogVideoSourceEntrySchema)
})

export const catalogVideoSourcePageSchema = z.object({
  items: z.array(catalogVideoSourceItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative()
})

export type CatalogVideoSourceEntry = z.infer<typeof catalogVideoSourceEntrySchema>
export type CatalogVideoSourceItem = z.infer<typeof catalogVideoSourceItemSchema>
export type CatalogVideoSourcePage = z.infer<typeof catalogVideoSourcePageSchema>
