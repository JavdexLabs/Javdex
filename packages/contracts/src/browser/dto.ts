/**
 * Browser HTTP DTOs stay on an independent whitelist.
 * Do not project manage rows by deleting fields.
 */
export type {
  WebAccessInput,
  WebAccessStatus,
  WebVideo,
  WebCollection,
  WebBrowse,
  WebResource,
  WebDetail,
  WebDevice,
  WebPairState
} from '../webTypes'

/** Fields that must never appear on browser DTOs or in renderer-held remote state. */
export const BROWSER_FORBIDDEN_FIELDS = [
  'writerToken',
  'writerEpoch',
  'operationId',
  'oneTimeToken',
  'uploadId',
  'expectedVersions',
  'cover_path',
  'poster_path',
  'avatar_path',
  'locator',
  'source_identity',
  'strm_source_path',
  'sourceFilePath',
  'sourcePaths'
] as const
