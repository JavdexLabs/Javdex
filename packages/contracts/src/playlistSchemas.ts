import { z } from 'zod'
import { relatedLinkSchema, videoSchema, videoCardSchema } from './catalogDetailSchemas'

export const playlistSchema = z.object({
  id: z.number(), name: z.string(), description: z.string().nullable(),
  cover_path: z.string().nullable(), created_at: z.string(), updated_at: z.string().nullable(),
  generation: z.number().optional(), revision: z.number().optional()
})
export const playlistDetailSchema = playlistSchema.extend({
  videos: z.array(videoSchema), links: z.array(relatedLinkSchema)
})
export const playlistMetadataSchema = playlistSchema.extend({
  links: z.array(relatedLinkSchema), preview_cover_path: z.string().nullable()
})
export const playlistVideosPageSchema = z.object({
  videos: z.array(videoCardSchema), total: z.number(), filteredTotal: z.number(),
  limit: z.number(), offset: z.number()
})
export const playlistPageSchema = playlistMetadataSchema.extend(playlistVideosPageSchema.shape)
export const playlistBrowseItemSchema = playlistSchema.pick({ id: true, name: true, description: true, generation: true, revision: true }).extend({
  preview_cover_path: z.string().nullable(), video_count: z.number(), contains_video: z.boolean()
})
export const playlistListPageSchema = z.object({
  items: z.array(playlistBrowseItemSchema), total: z.number(), offset: z.number(), limit: z.number(), hasExactName: z.boolean()
})
