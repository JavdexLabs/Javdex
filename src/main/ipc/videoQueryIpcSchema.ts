import { z } from 'zod'
import {
  MEDIA_LIBRARY_DEFAULT_SORTS,
  MEDIA_LIBRARY_SORT_DIRECTIONS
} from '@shared/mediaLibraryTypes'
import { VIDEO_LIST_PAGE_LIMIT_MAX, type VideoQuery } from '@shared/videoTypes'

export const positiveSafeInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

const uniquePositiveIds = z
  .array(positiveSafeInteger)
  .max(100)
  .refine((values) => new Set(values).size === values.length, '标签 ID 不能重复')

const uniqueResourceKinds = z
  .array(z.enum(['local', 'direct', 'web', 'magnet', 'ed2k', 'none']))
  .max(6)
  .refine((values) => new Set(values).size === values.length, '资源类型不能重复')

const videoQueryShape = {
  search: z.string().trim().max(500).optional(),
  scrapedStatus: z
    .union([z.literal(0), z.literal(1), z.literal(2), z.literal('all')])
    .optional(),
  minRating: z.number().finite().min(0).max(5).optional(),
  year: z.union([z.number().int().min(1901).max(9_999), z.literal('all')]).optional(),
  actressId: positiveSafeInteger.optional(),
  tagId: positiveSafeInteger.optional(),
  tagIds: uniquePositiveIds.optional(),
  makerOrganizationId: positiveSafeInteger.optional(),
  publisherOrganizationId: positiveSafeInteger.optional(),
  seriesId: positiveSafeInteger.optional(),
  directorId: positiveSafeInteger.optional(),
  codePrefix: z.string().trim().max(100).optional(),
  resourceKinds: uniqueResourceKinds.optional(),
  pendingScrape: z.enum(['all', 'pending', 'none']).optional(),
  sortBy: z.enum(MEDIA_LIBRARY_DEFAULT_SORTS).optional(),
  sortDir: z.enum(MEDIA_LIBRARY_SORT_DIRECTIONS).optional(),
  limit: z.number().int().min(1).max(VIDEO_LIST_PAGE_LIMIT_MAX).optional(),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
} satisfies Record<keyof VideoQuery, z.ZodType>

/** Renderer-owned list filters must cross IPC through this single strict contract. */
export const videoQueryIpcSchema = z.object(videoQueryShape).strict()
