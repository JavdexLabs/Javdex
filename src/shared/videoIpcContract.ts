import { IPC } from './ipc-channels'
import type {
  CorrectImportResult,
  VideoAsset,
  VideoEditInput,
  VideoFieldUpdateInput,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoQuery,
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResource,
  LastVideoResourceRemovalMode,
  VideoResourceRemovalResult,
  VideoSampleImportInput,
  VideoMergeInput,
  VideoMergeResult,
  VideoResourceSplitResult
} from './videoTypes'
import type { CatalogScope } from './mediaLibraryTypes'
import type { ScopedVideoDetail, ScopedVideoListResult } from './catalogTypes'
import type {
  DeleteVideoGloballyInput,
  MoveVideoResourceInput,
  RemoveVideoFromLibraryInput,
  VideoLifecycleImpact,
  VideoLifecycleResult
} from './videoLifecycleTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult
} from './typedIpcContract'

export interface VideoIpcContract {
  [IPC.VIDEO_LIST]: {
    args: [scope: CatalogScope, query?: VideoQuery]
    result: ScopedVideoListResult
  }
  [IPC.VIDEO_GET]: { args: [scope: CatalogScope, id: number]; result: ScopedVideoDetail | null }
  [IPC.VIDEO_UPDATE]: { args: [id: number, fields: VideoFieldUpdateInput]; result: boolean }
  [IPC.VIDEO_EDIT]: { args: [id: number, input: VideoEditInput]; result: boolean }
  [IPC.VIDEO_CLEAR_META]: { args: [id: number]; result: boolean }
  [IPC.VIDEO_MARK_SCRAPE_SUCCESS]: { args: [id: number]; result: boolean }
  [IPC.VIDEO_SET_RATING]: { args: [id: number, rating: number]; result: boolean }
  [IPC.VIDEO_CORRECT_IMPORT]: {
    args: [id: number, code: string, discardPendingScrape?: boolean]
    result: CorrectImportResult
  }
  [IPC.VIDEO_YEARS]: { args: [scope: CatalogScope]; result: number[] }
  [IPC.VIDEO_SAMPLE_IMPORT]: {
    args: [id: number, input: VideoSampleImportInput]
    result: VideoAsset
  }
  [IPC.VIDEO_SAMPLE_DELETE]: { args: [id: number, assetId: number]; result: boolean }
  [IPC.VIDEO_POSTER_SET]: {
    args: [id: number, posterPath: string | null]
    result: boolean
  }
  [IPC.VIDEO_MANUAL_TAG_ADD]: { args: [id: number, name: string]; result: boolean }
  [IPC.VIDEO_MANUAL_TAG_ADD_EXISTING]: { args: [id: number, tagId: number]; result: boolean }
  [IPC.VIDEO_MANUAL_TAG_REMOVE]: { args: [id: number, tagId: number]; result: boolean }
  [IPC.VIDEO_RESOURCE_IMPORT]: {
    args: [input: VideoLinkResourceImportInput]
    result: VideoResourceImportResult
  }
  [IPC.VIDEO_RESOURCE_GET]: {
    args: [libraryId: number, videoId: number, resourceId: number]
    result: VideoResource | null
  }
  [IPC.VIDEO_RESOURCE_CHECK]: {
    args: [url: string]
    result: VideoResourceLinkCheckResult
  }
  [IPC.VIDEO_RESOURCE_UPDATE]: {
    args: [
      libraryId: number,
      videoId: number,
      resourceId: number,
      input: VideoLinkResourceUpdateInput
    ]
    result: VideoResource
  }
  [IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL]: {
    args: [libraryId: number, videoId: number, resourceId: number, label: string | null]
    result: VideoResource
  }
  [IPC.VIDEO_RESOURCE_SET_PRIMARY]: {
    args: [libraryId: number, videoId: number, resourceId: number]
    result: boolean
  }
  [IPC.VIDEO_RESOURCE_REMOVE]: {
    args: [
      libraryId: number,
      videoId: number,
      resourceId: number,
      lastResourceMode?: LastVideoResourceRemovalMode
    ]
    result: VideoResourceRemovalResult
  }
  [IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW]: {
    args: [libraryId: number, videoId: number]
    result: VideoLifecycleImpact
  }
  [IPC.VIDEO_REMOVE_FROM_LIBRARY]: {
    args: [input: RemoveVideoFromLibraryInput]
    result: VideoLifecycleResult
  }
  [IPC.VIDEO_RESOURCE_MOVE_PREVIEW]: {
    args: [sourceLibraryId: number, targetLibraryId: number, resourceId: number]
    result: VideoLifecycleImpact
  }
  [IPC.VIDEO_RESOURCE_MOVE]: {
    args: [input: MoveVideoResourceInput]
    result: VideoLifecycleResult
  }
  [IPC.VIDEO_DELETE_GLOBAL_PREVIEW]: {
    args: [videoId: number]
    result: VideoLifecycleImpact
  }
  [IPC.VIDEO_DELETE_GLOBAL]: {
    args: [input: DeleteVideoGloballyInput]
    result: VideoLifecycleResult
  }
  [IPC.VIDEO_MERGE]: {
    args: [input: VideoMergeInput]
    result: VideoMergeResult
  }
  [IPC.VIDEO_RESOURCE_SPLIT]: {
    args: [libraryId: number, videoId: number, resourceId: number]
    result: VideoResourceSplitResult
  }
}

export type VideoIpcChannel = IpcContractChannel<VideoIpcContract>
export type VideoIpcArgs<Channel extends VideoIpcChannel> =
  IpcContractArgs<VideoIpcContract, Channel>
export type VideoIpcResult<Channel extends VideoIpcChannel> =
  IpcContractResult<VideoIpcContract, Channel>
