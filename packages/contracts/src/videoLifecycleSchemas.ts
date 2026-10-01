import { z } from 'zod'

const id = z.number().int().positive()
const count = z.number().int().nonnegative()
export const videoLifecycleKindSchema = z.enum(['remove-from-library', 'move-resource', 'delete-globally'])
export const videoLifecycleLibraryImpactSchema = z.object({
  libraryId: id, name: z.string(), status: z.enum(['active', 'archived']), resourceCount: count
})
export const videoLifecycleResourceImpactSchema = z.object({
  resourceId: id, libraryId: id,
  kind: z.enum(['local', 'direct', 'web', 'magnet', 'ed2k']),
  displayName: z.string().nullable(), displayLocator: z.string(), isPrimary: z.boolean(),
  /** Local video or STRM source deleted by global deletion; not a remote target URL. */
  sourceFilePath: z.string().nullable()
})
export const videoLifecyclePlaylistImpactSchema = z.object({ playlistId: id, name: z.string() })
export const videoLifecycleMediaAssetImpactSchema = z.object({
  /** Cover/poster fields stored on the video row have no separate asset ID. */
  assetId: id.nullable(), type: z.string(), localPath: z.string().nullable()
})

export const videoLifecycleImpactSchema = z.object({
  kind: videoLifecycleKindSchema,
  revision: z.string().min(1), videoId: id,
  sourceLibraryId: id.nullable(), targetLibraryId: id.nullable(),
  resourceIds: z.array(id), sourcePaths: z.array(z.string()), remainingLibraryIds: z.array(id),
  removesCanonicalVideo: z.boolean(), playlistCount: count, assetCount: count,
  libraries: z.array(videoLifecycleLibraryImpactSchema),
  resources: z.array(videoLifecycleResourceImpactSchema),
  playlists: z.array(videoLifecyclePlaylistImpactSchema),
  mediaAssets: z.array(videoLifecycleMediaAssetImpactSchema),
  pendingScrapeCount: count, pendingAgentDraftCount: count, pendingStagingAssetCount: count,
  sourceFilesPreserved: z.boolean()
})

export const videoLifecycleResultSchema = z.object({
  sourceMembershipRemoved: z.boolean().optional(),
  operationId: z.string().min(1), kind: videoLifecycleKindSchema, videoId: id,
  sourceLibraryId: id.nullable(), targetLibraryId: id.nullable(),
  resourceIds: z.array(id), promotedResourceId: id.nullable(), canonicalVideoDeleted: z.boolean()
})
