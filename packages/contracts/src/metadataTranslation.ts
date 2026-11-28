import { z } from 'zod'
import { DIRECT_ID_BATCH_MAX, STRING_FIELD_MAX } from './protocol/limits'

export const METADATA_TRANSLATION_FIELDS = ['title', 'summary'] as const
export type MetadataTranslationField = typeof METADATA_TRANSLATION_FIELDS[number]
export const translationFieldSchema = z.enum(METADATA_TRANSLATION_FIELDS)
export const translationTextSchema = z.string().trim().min(1).max(STRING_FIELD_MAX)
const id = z.number().int().positive()

export const translationTargetsSchema = z.object({
  libraryId: id, videoIds: z.array(id).min(1).max(DIRECT_ID_BATCH_MAX), includeText: z.boolean().optional()
}).strict()
export const translationTargetsResultSchema = z.array(z.object({
  id, generation: id, code: z.string(), title: z.string().nullable().optional(), summary: z.string().nullable().optional()
}).strict()).max(DIRECT_ID_BATCH_MAX)
export type TranslationTarget = z.infer<typeof translationTargetsResultSchema>[number]

const translationValueSchema = z.object({
  original: z.string().max(STRING_FIELD_MAX),
  translation: translationTextSchema
}).strict()

export const applyMetadataTranslationSchema = z.object({
  catalogId: z.string().min(1).max(100),
  serverId: z.string().min(1).max(100).nullable(),
  libraryId: z.number().int().positive(),
  videoId: z.number().int().positive(),
  generation: z.number().int().positive(),
  fields: z.object({ title: translationValueSchema.optional(), summary: translationValueSchema.optional() })
    .strict().refine(fields => !!fields.title || !!fields.summary)
}).strict()
export type ApplyMetadataTranslation = z.infer<typeof applyMetadataTranslationSchema>

const fieldOutcomeSchema = z.enum(['applied', 'conflict', 'locked', 'out-of-scope', 'missing'])
export type MetadataTranslationOutcome = z.infer<typeof fieldOutcomeSchema>
export const applyMetadataTranslationResultSchema = z.object({
  fields: z.object({ title: fieldOutcomeSchema.optional(), summary: fieldOutcomeSchema.optional() }).strict()
}).strict()
export type ApplyMetadataTranslationResult = z.infer<typeof applyMetadataTranslationResultSchema>
