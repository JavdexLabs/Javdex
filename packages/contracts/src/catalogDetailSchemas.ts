import { z } from 'zod'
import { MEDIA_LIBRARY_COLORS, MEDIA_LIBRARY_ICONS } from './mediaLibraryTypes'

/** Canonical fields for catalog detail JSON and the corresponding TypeScript DTOs. */
export const videoResourceKindSchema = z.enum(['local', 'direct', 'web', 'magnet', 'ed2k'])

export const actressSchema = z.object({
  id: z.number(),
  main_name: z.string(),
  avatar_path: z.string().nullable(),
  avatar_source_path: z.string().nullable(),
  avatar_crop_json: z.string().nullable(),
  poster_path: z.string().nullable(),
  birth_date: z.string().nullable(),
  debut_date: z.string().nullable(),
  height_cm: z.number().nullable(),
  bust_cm: z.number().nullable(),
  waist_cm: z.number().nullable(),
  hip_cm: z.number().nullable(),
  /** Single cup letter (A–Z); display suffix added in UI. */
  cup_size: z.string().nullable(),
  blood_type: z.string().nullable(),
  zodiac: z.string().nullable(),
  nationality: z.string().nullable(),
  profile_summary: z.string().nullable(),
  scraped_status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  last_scraped_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  gender: z.enum(['female', 'male']).nullable(),
  generation: z.number().optional(),
  revision: z.number().optional()
})

export const actressNameSchema = z.object({
  id: z.number(),
  actress_id: z.number(),
  name: z.string(),
  type: z.string(),
  locale: z.string().nullable(),
  source: z.string().nullable(),
  is_primary: z.number()
})

export const actressGalleryAssetSchema = z.object({
  id: z.number(),
  actress_id: z.number(),
  type: z.string(),
  position: z.number(),
  remote_url: z.string().nullable(),
  local_path: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  created_at: z.string().nullable()
})

export const videoSchema = z.object({
  id: z.number(),
  code: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  cover_path: z.string().nullable(),
  poster_path: z.string().nullable(),
  original_title: z.string().nullable(),
  rating: z.number(),
  release_date: z.string().nullable(),
  maker: z.string().nullable(),
  publisher: z.string().nullable(),
  maker_organization_id: z.number().nullable(),
  publisher_organization_id: z.number().nullable(),
  series: z.string().nullable(),
  director: z.string().nullable(),
  series_id: z.number().nullable(),
  director_id: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  scraped_status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  last_scraped_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  add_time: z.string(),
  generation: z.number().optional(),
  revision: z.number().optional(),
  primary_resource_kind: videoResourceKindSchema.nullable().optional(),
  resource_count: z.number().optional(),
  /** Primary kind first, followed by each remaining kind at most once. */
  resource_kinds: z.array(videoResourceKindSchema).optional(),
  /** Independent pending-decision dimension; not part of scraped_status. */
  has_pending_scrape: z.boolean().optional()
})

export const videoResourceSchema = z.object({
  id: z.number(),
  library_id: z.number(),
  video_id: z.number(),
  root_id: z.number().nullable(),
  kind: videoResourceKindSchema,
  locator: z.string(),
  resource_key: z.string(),
  source_identity: z.string().nullable(),
  strm_source_path: z.string().nullable(),
  size_bytes: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  file_mtime_ms: z.number().nullable(),
  display_name: z.string().nullable(),
  is_primary: z.number(),
  add_time: z.string()
})

export const videoAssetSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  type: z.string(),
  position: z.number(),
  remote_url: z.string().nullable(),
  local_path: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  is_primary: z.number(),
  created_at: z.string().nullable()
})

export const videoExternalStatsSchema = z.object({
  id: z.number(),
  video_id: z.number(),
  source: z.string(),
  rating_average: z.number().nullable(),
  rating_count: z.number().nullable(),
  fetched_at: z.string().nullable()
})

export const relatedLinkSchema = z.object({ label: z.string(), url: z.string(), position: z.number() })
export const videoResourceDetailSchema = videoResourceSchema.omit({
  locator: true, resource_key: true, source_identity: true
}).extend({
  /** Display only; never a playback locator. */
  display_locator: z.string()
}).strict()
export const videoTagSchema = z.object({
  id: z.number(), name: z.string(), origin: z.enum(['manual', 'scraped']), source: z.string().nullable()
})
export const videoDetailSchema = videoSchema.extend({
  resources: z.array(videoResourceDetailSchema),
  actresses: z.array(actressSchema),
  tags: z.array(videoTagSchema),
  assets: z.array(videoAssetSchema),
  external_stats: z.array(videoExternalStatsSchema),
  links: z.array(relatedLinkSchema),
  resolved_duration_seconds: z.number().nullable().optional()
})
export const mediaLibraryBadgeSchema = z.object({
  libraryId: z.number(), name: z.string(),
  icon: z.enum(MEDIA_LIBRARY_ICONS), color: z.enum(MEDIA_LIBRARY_COLORS)
})
export const scopedVideoDetailSchema = videoDetailSchema.extend({
  activeLibraryId: z.number(), membershipAddedAt: z.string(), libraries: z.array(mediaLibraryBadgeSchema)
})

export const actressMetadataSchema = actressSchema.extend({
  name_zh: z.string().nullable(), name_en: z.string().nullable(),
  aliases: z.array(z.string()), names: z.array(actressNameSchema),
  gallery: z.array(actressGalleryAssetSchema), links: z.array(relatedLinkSchema)
})
export const actressDetailSchema = actressMetadataSchema.extend({ videos: z.array(videoSchema) })
export const actressProfileSchema = actressMetadataSchema.omit({ gallery: true }).extend({
  gallery_count: z.number(), display_gallery_count: z.number(), first_gallery: actressGalleryAssetSchema.nullable()
})
