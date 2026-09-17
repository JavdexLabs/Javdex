import { structuredError } from '@shared/protocol/errors'
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
  if (operation in booleanOperations) {
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
  // Other operations share the declared domain DTO. The untyped HTTP client's
  // JSON result is asserted only here, never inside a caller or a backend port.
  return result as CatalogOperationResults[K]
}
