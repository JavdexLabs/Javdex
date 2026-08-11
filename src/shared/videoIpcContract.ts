import { IPC } from './ipc-channels'
import type {
  CorrectImportResult,
  VideoAsset,
  VideoDetail,
  VideoEditInput,
  VideoFieldUpdateInput,
  VideoListResult,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoQuery,
  VideoResourceImportResult,
  VideoResourceLinkCheckResult,
  VideoResource,
  LastVideoResourceRemovalMode,
  VideoResourceRemovalResult,
  VideoSampleImportInput
} from './videoTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult
} from './typedIpcContract'

export interface VideoIpcContract {
  [IPC.VIDEO_LIST]: { args: [query?: VideoQuery]; result: VideoListResult }
  [IPC.VIDEO_GET]: { args: [id: number]; result: VideoDetail | null }
  [IPC.VIDEO_UPDATE]: { args: [id: number, fields: VideoFieldUpdateInput]; result: boolean }
  [IPC.VIDEO_EDIT]: { args: [id: number, input: VideoEditInput]; result: boolean }
  [IPC.VIDEO_CLEAR_META]: { args: [id: number]; result: boolean }
  [IPC.VIDEO_MARK_SCRAPE_SUCCESS]: { args: [id: number]; result: boolean }
  [IPC.VIDEO_DELETE]: { args: [id: number]; result: boolean }
  [IPC.VIDEO_SET_RATING]: { args: [id: number, rating: number]; result: boolean }
  [IPC.VIDEO_CORRECT_IMPORT]: {
    args: [id: number, code: string]
    result: CorrectImportResult
  }
  [IPC.VIDEO_YEARS]: { args: []; result: number[] }
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
  [IPC.VIDEO_MANUAL_TAG_REMOVE]: { args: [id: number, tagId: number]; result: boolean }
  [IPC.VIDEO_RESOURCE_IMPORT]: {
    args: [input: VideoLinkResourceImportInput]
    result: VideoResourceImportResult
  }
  [IPC.VIDEO_RESOURCE_GET]: {
    args: [videoId: number, resourceId: number]
    result: VideoResource | null
  }
  [IPC.VIDEO_RESOURCE_CHECK]: {
    args: [url: string]
    result: VideoResourceLinkCheckResult
  }
  [IPC.VIDEO_RESOURCE_UPDATE]: {
    args: [videoId: number, resourceId: number, input: VideoLinkResourceUpdateInput]
    result: VideoResource
  }
  [IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL]: {
    args: [videoId: number, resourceId: number, label: string | null]
    result: VideoResource
  }
  [IPC.VIDEO_RESOURCE_SET_PRIMARY]: {
    args: [videoId: number, resourceId: number]
    result: boolean
  }
  [IPC.VIDEO_RESOURCE_REMOVE]: {
    args: [
      videoId: number,
      resourceId: number,
      lastResourceMode?: LastVideoResourceRemovalMode
    ]
    result: VideoResourceRemovalResult
  }
}

export type VideoIpcChannel = IpcContractChannel<VideoIpcContract>
export type VideoIpcArgs<Channel extends VideoIpcChannel> =
  IpcContractArgs<VideoIpcContract, Channel>
export type VideoIpcResult<Channel extends VideoIpcChannel> =
  IpcContractResult<VideoIpcContract, Channel>
