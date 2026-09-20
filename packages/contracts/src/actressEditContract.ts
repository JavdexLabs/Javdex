import { z } from 'zod'
import { aggregateVersionSchema, limitedTextSchema, tagNamesSchema, relatedLinksSchema } from './manage/primitives'

export const actressEditResultSchema = z.object({
  ok: z.boolean(), versions: z.object({ A: aggregateVersionSchema })
})
export type ActressEditResult = z.infer<typeof actressEditResultSchema>

/** Shared profile fields; image handles remain host-specific. */
export const actressProfileEditFieldsSchema = z.object({
  main_name: limitedTextSchema.optional(),
  name_zh: limitedTextSchema.nullable().optional(),
  name_en: limitedTextSchema.nullable().optional(),
  aliases: tagNamesSchema.optional(),
  profile_summary: limitedTextSchema.nullable().optional(),
  gender: z.enum(['female', 'male']).nullable().optional(),
  birth_date: z.string().max(32).nullable().optional(),
  debut_date: z.string().max(32).nullable().optional(),
  height_cm: z.number().int().positive().nullable().optional(),
  bust_cm: z.number().int().positive().nullable().optional(),
  waist_cm: z.number().int().positive().nullable().optional(),
  hip_cm: z.number().int().positive().nullable().optional(),
  cup_size: z.string().max(8).nullable().optional(),
  blood_type: z.string().max(8).nullable().optional(),
  zodiac: z.string().max(32).nullable().optional(),
  nationality: z.string().max(80).nullable().optional(),
  links: relatedLinksSchema.optional()
}).strict()
export type ActressProfileEditFields = z.infer<typeof actressProfileEditFieldsSchema>
