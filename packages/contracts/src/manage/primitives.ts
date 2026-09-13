import { z } from 'zod'
import {
  CODE_MAX,
  DIRECT_ID_BATCH_MAX,
  MANAGE_IMAGE_CONTENT_TYPES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  RELATED_LINK_LABEL_MAX,
  RELATED_LINK_MAX,
  RELATED_LINK_URL_MAX,
  SEARCH_STRING_MAX,
  STRING_FIELD_MAX,
  TAG_NAME_MAX
} from '../protocol/limits'
import { VERSION_SCOPES } from '../protocol/versions'
import { MANAGE_ERROR_CODES } from '../protocol/errorCodes'
import { UPLOAD_PURPOSES } from '../protocol/uploads'
import { CATALOG_TASK_STATES } from '../protocol/tasks'

export const uuidSchema = z.uuid()
export const idSchema = z.number().int().positive()
export const epochSchema = z.number().int().nonnegative()
export const generationSchema = z.number().int().positive()
export const revisionNumberSchema = z.number().int().nonnegative()
export const isoTimeSchema = z.string().min(1).max(40)
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const limitedTextSchema = z.string().max(STRING_FIELD_MAX)
export const searchTextSchema = z.string().max(SEARCH_STRING_MAX)
export const codeSchema = z.string().min(1).max(CODE_MAX)
export const tagNameSchema = z.string().min(1).max(TAG_NAME_MAX)

export const aggregateVersionSchema = z
  .object({
    generation: generationSchema,
    revision: revisionNumberSchema
  })
  .strict()

export const expectedVersionsSchema = z
  .object({
    V: aggregateVersionSchema.optional(),
    R: aggregateVersionSchema.optional(),
    A: aggregateVersionSchema.optional(),
    F: aggregateVersionSchema.optional(),
    P: aggregateVersionSchema.optional(),
    L: aggregateVersionSchema.optional(),
    C: aggregateVersionSchema.optional(),
    G: aggregateVersionSchema.optional(),
    Q: aggregateVersionSchema.optional()
  })
  .strict()

export const manageAuthSchema = z
  .object({
    serverId: uuidSchema,
    catalogId: uuidSchema,
    writerEpoch: epochSchema.optional()
  })
  .strict()

export const manageQueryEnvelopeSchema = <T extends z.ZodType>(input: T) =>
  manageAuthSchema.extend({ input }).strict()

export const manageMutationEnvelopeSchema = <T extends z.ZodType>(input: T) =>
  z
    .object({
      operationId: uuidSchema,
      serverId: uuidSchema,
      catalogId: uuidSchema,
      writerEpoch: epochSchema,
      expectedVersions: expectedVersionsSchema,
      input
    })
    .strict()

export const catalogImageRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), uploadId: uuidSchema }).strict(),
  z.object({ kind: z.literal('asset'), assetId: idSchema }).strict(),
  z.object({ kind: z.literal('clear') }).strict()
])

export const catalogScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), libraryId: idSchema }).strict(),
  z
    .object({
      kind: z.literal('all'),
      libraryIds: z.array(idSchema).max(DIRECT_ID_BATCH_MAX).optional()
    })
    .strict()
])

export const pageQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0)
  })
  .strict()

export const idListSchema = z
  .array(idSchema)
  .max(DIRECT_ID_BATCH_MAX)
  .refine((values) => new Set(values).size === values.length, 'IDs must be unique')

export const relatedLinkInputSchema = z
  .object({
    label: z.string().min(1).max(RELATED_LINK_LABEL_MAX),
    url: z.string().url().max(RELATED_LINK_URL_MAX)
  })
  .strict()

export const relatedLinksSchema = z.array(relatedLinkInputSchema).max(RELATED_LINK_MAX)
export const tagNamesSchema = z.array(tagNameSchema).max(200)
export const errorCodeSchema = z.enum(MANAGE_ERROR_CODES)
export const versionScopeSchema = z.enum(VERSION_SCOPES)
export const uploadPurposeSchema = z.enum(UPLOAD_PURPOSES)
export const imageContentTypeSchema = z.enum(MANAGE_IMAGE_CONTENT_TYPES)
export const taskStateSchema = z.enum(CATALOG_TASK_STATES)
export const sortDirSchema = z.enum(['asc', 'desc'])

export const organizationAssignmentSchema = z.union([
  z.object({ organizationId: idSchema }).strict(),
  z.object({ createName: limitedTextSchema.min(1) }).strict()
])

export const directorAssignmentSchema = z.union([
  z.object({ directorId: idSchema }).strict(),
  z.object({ createName: limitedTextSchema.min(1) }).strict()
])

export const seriesAssignmentSchema = z.union([
  z.object({ seriesId: idSchema }).strict(),
  z.object({ createName: limitedTextSchema.min(1) }).strict()
])

export const mountSelectionSchema = z
  .object({
    mountSelectionId: z.string().min(1).max(200)
  })
  .strict()

export function parseUnknownRejected<T>(schema: z.ZodType<T>, value: unknown): z.ZodSafeParseResult<T> {
  return schema.safeParse(value)
}

export const jsonRequestByteLimit = (json: string, maxBytes: number): boolean =>
  new TextEncoder().encode(json).length <= maxBytes
