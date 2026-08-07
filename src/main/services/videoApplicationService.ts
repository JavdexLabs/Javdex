import type {
  CorrectImportResult,
  Video,
  VideoAsset,
  VideoDetail,
  VideoEditInput,
  VideoListResult,
  VideoQuery,
  VideoSampleImportInput
} from '@shared/videoTypes'
import {
  listVideos,
  listYears,
  setRating,
  setVideoPosterPath,
  updateVideoFields
} from '../db/videoRepo'
import {
  addVideoManualTag,
  clearVideoMetadata,
  correctVideoCode,
  deleteVideoFile,
  deleteVideoSample,
  deleteVideoWithFile,
  editVideo,
  getVideoDetailForUi,
  importVideoSample,
  markVideoScrapeSuccess,
  removeVideoManualTag,
  setVideoPrimaryFile
} from './videoService'

export interface VideoApplicationService {
  list(query?: VideoQuery): VideoListResult
  get(id: number): VideoDetail | null
  update(id: number, fields: Partial<Video>): boolean
  edit(id: number, input: VideoEditInput): boolean
  clearMetadata(id: number): boolean
  markScrapeSucceeded(id: number): boolean
  delete(id: number): boolean
  setRating(id: number, rating: number): boolean
  setPrimaryFile(videoId: number, fileId: number): boolean
  deleteFile(videoId: number, fileId: number): boolean
  correctImport(id: number, code: string): CorrectImportResult
  listYears(): number[]
  importSample(id: number, input: VideoSampleImportInput): Promise<VideoAsset>
  deleteSample(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
  addManualTag(id: number, name: string): boolean
  removeManualTag(id: number, tagId: number): boolean
}

export function createVideoApplicationService(): VideoApplicationService {
  return {
    list: (query) => listVideos(query ?? {}),
    get: getVideoDetailForUi,
    update(id, fields) {
      updateVideoFields(id, fields)
      return true
    },
    edit(id, input) {
      editVideo(id, input)
      return true
    },
    clearMetadata(id) {
      clearVideoMetadata(id)
      return true
    },
    markScrapeSucceeded(id) {
      markVideoScrapeSuccess(id)
      return true
    },
    delete(id) {
      deleteVideoWithFile(id)
      return true
    },
    setRating(id, ratingValue) {
      setRating(id, ratingValue)
      return true
    },
    setPrimaryFile(videoId, fileId) {
      setVideoPrimaryFile(videoId, fileId)
      return true
    },
    deleteFile(videoId, fileId) {
      deleteVideoFile(videoId, fileId)
      return true
    },
    correctImport: correctVideoCode,
    listYears,
    importSample: importVideoSample,
    deleteSample(id, assetId) {
      deleteVideoSample(id, assetId)
      return true
    },
    setPoster(id, posterPath) {
      setVideoPosterPath(id, posterPath)
      return true
    },
    addManualTag(id, name) {
      addVideoManualTag(id, name)
      return true
    },
    removeManualTag(id, tagId) {
      removeVideoManualTag(id, tagId)
      return true
    }
  }
}

export const videoApplicationService = createVideoApplicationService()
