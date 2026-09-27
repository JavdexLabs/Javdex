/**
 * First-release engineering defaults for desktop/manage contracts.
 * Values may be retuned after measurement; callers must reject rather than
 * silently truncate when a limit is exceeded.
 */
export const JSON_REQUEST_MAX_BYTES = 1 * 1024 * 1024
export const PAGE_SIZE_DEFAULT = 50
export const PAGE_SIZE_MAX = 200
export const DIRECT_ID_BATCH_MAX = 200
export const STRING_FIELD_MAX = 8 * 1024
export const SEARCH_STRING_MAX = 500
export const RELATED_LINK_MAX = 50
export const RELATED_LINK_LABEL_MAX = 200
export const RELATED_LINK_URL_MAX = 2048
export const TAG_NAME_MAX = 200
export const CODE_MAX = 200
export const UPLOAD_STREAM_MAX_BYTES = 32 * 1024 * 1024
/** Existing local encoded-asset read budget; uploads are stricter. */
export const STORED_ASSET_READ_MAX_BYTES = 64 * 1024 * 1024
export const ASSET_PIXEL_BUDGET = 64 * 1024 * 1024
export const CLAIM_CREDENTIAL_TTL_MS = 10 * 60 * 1000
export const PLAN_TTL_MS = 10 * 60 * 1000
export const PLAY_GRANT_TTL_MS = 12 * 60 * 60 * 1000
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000
export const TASK_POLL_INTERVAL_MS = 2_000
export const TASK_POLL_MAX_BACKOFF_MS = 30_000
export const SECRET_RANDOM_BYTES = 32
export const UUID_STRING_MAX = 36

export const MANAGE_IMAGE_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
] as const

export type ManageImageContentType = (typeof MANAGE_IMAGE_CONTENT_TYPES)[number]
