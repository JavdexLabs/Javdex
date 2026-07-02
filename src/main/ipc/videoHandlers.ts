import { IPC } from '@shared/ipc-channels'
import type {
  CorrectImportResult,
  Video,
  VideoAsset,
  VideoDetail,
  VideoEditInput,
  VideoListResult,
  VideoSampleImportInput,
  VideoQuery
} from '@shared/types'
import {
  getVideoDetail,
  listVideos,
  listYears,
  setRating,
  setVideoPosterPath,
  updateVideoFields
} from '../db/videoRepo'
import {
  clearVideoMetadata,
  correctVideoCode,
  deleteVideoWithFile,
  deleteVideoSample,
  addVideoManualTag,
  editVideo,
  importVideoSample,
  removeVideoManualTag
} from '../services/videoService'
import { registerHandler } from './shared'

export function registerVideoHandlers(): void {
  registerHandler(IPC.VIDEO_LIST, (_e, q: VideoQuery): VideoListResult => listVideos(q ?? {}))

  registerHandler(IPC.VIDEO_GET, (_e, id: number): VideoDetail | null => getVideoDetail(id))

  registerHandler(IPC.VIDEO_UPDATE, (_e, id: number, fields: Partial<Video>): boolean => {
    updateVideoFields(id, fields)
    return true
  })

  registerHandler(IPC.VIDEO_EDIT, (_e, id: number, input: VideoEditInput): boolean => {
    editVideo(id, input)
    return true
  })

  registerHandler(IPC.VIDEO_CLEAR_META, (_e, id: number): boolean => {
    clearVideoMetadata(id)
    return true
  })

  registerHandler(
    IPC.VIDEO_CORRECT_IMPORT,
    (_e, id: number, code: string): CorrectImportResult => correctVideoCode(id, code)
  )

  registerHandler(IPC.VIDEO_DELETE, (_e, id: number): boolean => {
    deleteVideoWithFile(id)
    return true
  })

  registerHandler(IPC.VIDEO_SET_RATING, (_e, id: number, rating: number): boolean => {
    setRating(id, rating)
    return true
  })

  registerHandler(IPC.VIDEO_YEARS, (): number[] => listYears())

  registerHandler(
    IPC.VIDEO_SAMPLE_IMPORT,
    (_e, id: number, input: VideoSampleImportInput): Promise<VideoAsset> =>
      importVideoSample(id, input)
  )

  registerHandler(IPC.VIDEO_SAMPLE_DELETE, (_e, id: number, assetId: number): boolean => {
    deleteVideoSample(id, assetId)
    return true
  })

  registerHandler(IPC.VIDEO_POSTER_SET, (_e, id: number, posterPath: string | null): boolean => {
    setVideoPosterPath(id, posterPath)
    return true
  })

  registerHandler(IPC.VIDEO_MANUAL_TAG_ADD, (_e, id: number, name: string): boolean => {
    addVideoManualTag(id, name)
    return true
  })

  registerHandler(IPC.VIDEO_MANUAL_TAG_REMOVE, (_e, id: number, tagId: number): boolean => {
    removeVideoManualTag(id, tagId)
    return true
  })
}
