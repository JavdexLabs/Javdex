import type { z } from 'zod'
import type {
  videoLifecycleKindSchema,
  videoLifecycleLibraryImpactSchema,
  videoLifecycleResourceImpactSchema,
  videoLifecyclePlaylistImpactSchema,
  videoLifecycleMediaAssetImpactSchema,
  videoLifecycleImpactSchema,
  videoLifecycleResultSchema
} from './videoLifecycleSchemas'

export type VideoLifecycleKind = z.infer<typeof videoLifecycleKindSchema>
export type VideoLifecycleLibraryImpact = z.infer<typeof videoLifecycleLibraryImpactSchema>
export type VideoLifecycleResourceImpact = z.infer<typeof videoLifecycleResourceImpactSchema>
export type VideoLifecyclePlaylistImpact = z.infer<typeof videoLifecyclePlaylistImpactSchema>
export type VideoLifecycleMediaAssetImpact = z.infer<typeof videoLifecycleMediaAssetImpactSchema>
export type VideoLifecycleImpact = z.infer<typeof videoLifecycleImpactSchema>
export type VideoLifecycleResult = z.infer<typeof videoLifecycleResultSchema>

export interface VideoLifecycleCommitInput {
  operationId: string
  expectedRevision: string
}

export interface RemoveVideoFromLibraryInput extends VideoLifecycleCommitInput {
  libraryId: number
  videoId: number
}

export interface MoveVideoResourceInput extends VideoLifecycleCommitInput {
  sourceLibraryId: number
  targetLibraryId: number
  resourceId: number
}

export interface DeleteVideoGloballyInput extends VideoLifecycleCommitInput {
  videoId: number
}
