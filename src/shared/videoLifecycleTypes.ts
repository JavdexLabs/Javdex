export type VideoLifecycleKind =
  | 'remove-from-library'
  | 'move-resource'
  | 'delete-globally'

export interface VideoLifecycleLibraryImpact {
  libraryId: number
  name: string
  status: 'active' | 'archived'
  resourceCount: number
}

export interface VideoLifecycleResourceImpact {
  resourceId: number
  libraryId: number
  kind: 'local' | 'direct' | 'web' | 'magnet' | 'ed2k'
  displayName: string | null
  /** Credential-safe display value. External resource secrets are never exposed by a preview. */
  displayLocator: string
  isPrimary: boolean
  /** Local video or STRM source deleted from disk by the global-delete command. */
  sourceFilePath: string | null
}

export interface VideoLifecyclePlaylistImpact {
  playlistId: number
  name: string
}

export interface VideoLifecycleMediaAssetImpact {
  /** Null for the cover/poster fields stored directly on the canonical video row. */
  assetId: number | null
  type: string
  localPath: string | null
}

export interface VideoLifecycleImpact {
  kind: VideoLifecycleKind
  revision: string
  videoId: number
  sourceLibraryId: number | null
  targetLibraryId: number | null
  resourceIds: number[]
  sourcePaths: string[]
  remainingLibraryIds: number[]
  removesCanonicalVideo: boolean
  playlistCount: number
  assetCount: number
  libraries: VideoLifecycleLibraryImpact[]
  resources: VideoLifecycleResourceImpact[]
  playlists: VideoLifecyclePlaylistImpact[]
  mediaAssets: VideoLifecycleMediaAssetImpact[]
  pendingScrapeCount: number
  pendingAgentDraftCount: number
  pendingStagingAssetCount: number
  /** Global deletion removes resource records and local/STRM source files. */
  sourceFilesPreserved: boolean
}

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

export interface VideoLifecycleResult {
  operationId: string
  kind: VideoLifecycleKind
  videoId: number
  sourceLibraryId: number | null
  targetLibraryId: number | null
  resourceIds: number[]
  promotedResourceId: number | null
  canonicalVideoDeleted: boolean
}
