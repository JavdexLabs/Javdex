import { playlistApplyImportResultSchema } from '@shared/playlistImportCommit'
import { playlistDetailSchema, playlistMetadataSchema, playlistPageSchema, playlistVideosPageSchema, playlistListPageSchema } from '@shared/playlistSchemas'
import { actressEditResultSchema } from '@shared/actressEditContract'
import { structuredError } from '@shared/protocol/errors'
import { scopedVideoDetailSchema, actressDetailSchema, actressProfileSchema, actressMetadataSchema } from '@shared/catalogDetailSchemas'
import type { CatalogOperationResults } from '../../application/catalogOperationResults'

type OperationsReturning<T> = {
  [K in keyof CatalogOperationResults]: CatalogOperationResults[K] extends T ? K : never
}[keyof CatalogOperationResults]

const booleanOperations = {
  'videos.edit': true,
  'videos.clearMeta': true,
  'videos.markScrapeSuccess': true,
  'videos.markScrapeFailed': true,
  'videos.setRating': true,
  'videos.setPoster': true,
  'videos.deleteSample': true,
  'videos.addManualTag': true,
  'videos.addExistingManualTag': true,
  'videos.removeManualTag': true,
  'videos.setPrimaryResource': true,
  'actresses.edit': true,
  'actresses.clearMeta': true,
  'actresses.deleteGallery': true,
  'actresses.setPoster': true,
  'actresses.merge': true,
  'actresses.markScrapeSuccess': true,
  'actresses.markScrapeFailed': true,
  'organizations.update': true,
  'directors.update': true,
  'series.update': true,
  'playlists.update': true,
  'playlists.delete': true,
  'playlists.addVideo': true,
  'playlists.removeVideo': true
} satisfies Record<OperationsReturning<boolean>, true>

const complexResultSchemas = {
  'videos.get': scopedVideoDetailSchema.nullable(),
  'actresses.get': actressDetailSchema.nullable(),
  'actresses.profile': actressProfileSchema.nullable(),
  'actresses.metadata': actressMetadataSchema.nullable(),
  'actresses.edit': actressEditResultSchema,
  'playlists.get': playlistDetailSchema.nullable(),
  'playlists.metadata': playlistMetadataSchema.nullable(),
  'playlists.getPage': playlistPageSchema.nullable(),
  'playlists.videoPage': playlistVideosPageSchema.nullable(),
  'playlists.listPage': playlistListPageSchema,
  'playlists.applyImport': playlistApplyImportResultSchema
} satisfies Partial<Record<keyof CatalogOperationResults, import('zod').ZodType>>

/** HTTP envelopes and local primitive results meet at this one adapter boundary. */
export function catalogRemoteResult<K extends keyof CatalogOperationResults>(
  operation: K,
  response: unknown
): CatalogOperationResults[K] {
  // Some command transports retain the commit envelope instead of spreading
  // its data. Only unwrap the explicit envelope, never an arbitrary DTO's data.
  if (response && typeof response === 'object' && 'receipt' in response && 'data' in response) {
    response = response.data
  }
  const object = response !== null && typeof response === 'object' ? response : null
  let result: unknown = response
  const schema = (complexResultSchemas as Partial<Record<keyof CatalogOperationResults, import('zod').ZodType>>)[operation]
  if (schema) {
    const parsed = schema.safeParse(response)
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.') ?? ''
      throw structuredError('INVALID_INPUT', `Invalid result for ${operation} at ${field}`, { field })
    }
    result = operation === 'actresses.edit' ? (parsed.data as { ok: boolean }).ok : parsed.data
  } else if (operation in booleanOperations) {
    if (typeof response === 'boolean') result = response
    else if (object && 'ok' in object && typeof object.ok === 'boolean') result = object.ok
    else if (
      object && 'versions' in object &&
      (operation === 'videos.setPoster' || operation === 'actresses.setPoster' || operation === 'playlists.update')
    ) result = true
    else throw structuredError('INVALID_INPUT', `Invalid boolean result for ${operation}`)
  } else if (
    operation === 'organizations.create' || operation === 'directors.create' ||
    operation === 'series.create' || operation === 'playlists.create'
  ) {
    const key = operation === 'playlists.create' ? 'playlistId' : 'id'
    if (typeof response === 'number') result = response
    else if (object && key in object && typeof Reflect.get(object, key) === 'number') result = Reflect.get(object, key)
    else throw structuredError('INVALID_INPUT', `Invalid id result for ${operation}`)
  }
  // Unmigrated operations still share a static DTO; complex result schemas are
  // introduced per use case, alongside real HTTP round-trip coverage.
  return result as CatalogOperationResults[K]
}
