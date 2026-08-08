import fs from 'node:fs'
import type {
  CorrectImportResult,
  Video,
  VideoAsset,
  VideoEditInput,
  VideoSampleImportInput
} from '@shared/videoTypes'
import {
  addManualVideoTag,
  addVideoSampleAsset,
  clearVideoMetadataRecord,
  deleteVideoSampleAsset,
  editVideoRecord,
  getPrimaryVideoFile,
  getVideoByCode,
  getVideoById,
  getVideoFileById,
  listVideoFiles,
  markScrapeSucceeded,
  mergeVideoIntoExistingCode,
  purgeVideo,
  removeManualVideoTag,
  removeVideoFileRecord,
  renameVideoCode,
  setPrimaryVideoFile,
  setRating,
  setVideoPosterPath,
  updateVideoFields
} from '../db/videoRepo'
import { mediaAssetStore } from './mediaAssetStore'
import { fetchRemoteImageBuffer } from './remoteImageFetch'

export interface VideoMaintenanceService {
  update(id: number, fields: Partial<Video>): boolean
  edit(id: number, input: VideoEditInput): boolean
  clearMetadata(id: number): boolean
  markScrapeSucceeded(id: number): boolean
  delete(id: number): boolean
  setRating(id: number, rating: number): boolean
  setPrimaryFile(videoId: number, fileId: number): boolean
  deleteFile(videoId: number, fileId: number): boolean
  correctImport(id: number, code: string): CorrectImportResult
  importSample(id: number, input: VideoSampleImportInput): Promise<VideoAsset>
  deleteSample(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
  addManualTag(id: number, name: string): boolean
  removeManualTag(id: number, tagId: number): boolean
}

interface VideoMaintenanceServiceDependencies {
  getVideoById: typeof getVideoById
  getVideoByCode: typeof getVideoByCode
  getVideoFileById: typeof getVideoFileById
  getPrimaryVideoFile: typeof getPrimaryVideoFile
  listVideoFiles: typeof listVideoFiles
  updateVideoFields: typeof updateVideoFields
  editVideoRecord: typeof editVideoRecord
  clearVideoMetadataRecord: typeof clearVideoMetadataRecord
  markScrapeSucceeded: typeof markScrapeSucceeded
  setRating: typeof setRating
  setPrimaryVideoFile: typeof setPrimaryVideoFile
  removeVideoFileRecord: typeof removeVideoFileRecord
  renameVideoCode: typeof renameVideoCode
  mergeVideoIntoExistingCode: typeof mergeVideoIntoExistingCode
  purgeVideo: typeof purgeVideo
  addVideoSampleAsset: typeof addVideoSampleAsset
  deleteVideoSampleAsset: typeof deleteVideoSampleAsset
  setVideoPosterPath: typeof setVideoPosterPath
  addManualVideoTag: typeof addManualVideoTag
  removeManualVideoTag: typeof removeManualVideoTag
  runInCoordinatedChange: typeof mediaAssetStore.runInCoordinatedChange
  coordinateDatabaseChange: typeof mediaAssetStore.coordinateDatabaseChange
  importCover: typeof mediaAssetStore.importCover
  importSample: typeof mediaAssetStore.importSample
  downloadSamples: typeof mediaAssetStore.downloadSamples
  deleteBestEffort: typeof mediaAssetStore.deleteBestEffort
  fetchRemoteImageBuffer: typeof fetchRemoteImageBuffer
  fileExists: (path: string) => boolean
  unlinkSync: (path: string) => void
}

export function createVideoMaintenanceService(
  dependencies: Partial<VideoMaintenanceServiceDependencies> = {}
): VideoMaintenanceService {
  const readVideoById = dependencies.getVideoById ?? getVideoById
  const readVideoByCode = dependencies.getVideoByCode ?? getVideoByCode
  const readVideoFileById = dependencies.getVideoFileById ?? getVideoFileById
  const readPrimaryVideoFile = dependencies.getPrimaryVideoFile ?? getPrimaryVideoFile
  const readVideoFiles = dependencies.listVideoFiles ?? listVideoFiles
  const writeVideoFields = dependencies.updateVideoFields ?? updateVideoFields
  const writeVideoRecord = dependencies.editVideoRecord ?? editVideoRecord
  const clearMetadataRecord = dependencies.clearVideoMetadataRecord ?? clearVideoMetadataRecord
  const recordScrapeSucceeded = dependencies.markScrapeSucceeded ?? markScrapeSucceeded
  const writeRating = dependencies.setRating ?? setRating
  const writePrimaryFile = dependencies.setPrimaryVideoFile ?? setPrimaryVideoFile
  const removeFileRecord = dependencies.removeVideoFileRecord ?? removeVideoFileRecord
  const renameCode = dependencies.renameVideoCode ?? renameVideoCode
  const mergeIntoExistingCode = dependencies.mergeVideoIntoExistingCode ?? mergeVideoIntoExistingCode
  const purgeVideoRecord = dependencies.purgeVideo ?? purgeVideo
  const addSampleAsset = dependencies.addVideoSampleAsset ?? addVideoSampleAsset
  const deleteSampleAsset = dependencies.deleteVideoSampleAsset ?? deleteVideoSampleAsset
  const writePoster = dependencies.setVideoPosterPath ?? setVideoPosterPath
  const writeManualTag = dependencies.addManualVideoTag ?? addManualVideoTag
  const deleteManualTag = dependencies.removeManualVideoTag ?? removeManualVideoTag
  const runInCoordinatedChange =
    dependencies.runInCoordinatedChange ?? mediaAssetStore.runInCoordinatedChange.bind(mediaAssetStore)
  const coordinateDatabaseChange =
    dependencies.coordinateDatabaseChange ??
    mediaAssetStore.coordinateDatabaseChange.bind(mediaAssetStore)
  const importCover = dependencies.importCover ?? mediaAssetStore.importCover.bind(mediaAssetStore)
  const importSampleAsset =
    dependencies.importSample ?? mediaAssetStore.importSample.bind(mediaAssetStore)
  const downloadSamples =
    dependencies.downloadSamples ?? mediaAssetStore.downloadSamples.bind(mediaAssetStore)
  const deleteBestEffort =
    dependencies.deleteBestEffort ?? mediaAssetStore.deleteBestEffort.bind(mediaAssetStore)
  const fetchRemoteBuffer = dependencies.fetchRemoteImageBuffer ?? fetchRemoteImageBuffer
  const fileExists = dependencies.fileExists ?? ((path) => fs.existsSync(path))
  const unlinkSync = dependencies.unlinkSync ?? ((path) => fs.unlinkSync(path))

  return {
    update(id, fields): boolean {
      writeVideoFields(id, fields)
      return true
    },
    edit(id, input): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      runInCoordinatedChange(() => {
        const coverRelPath = input.coverSourcePath
          ? importCover(video.code, input.coverSourcePath)
          : undefined
        const result = writeVideoRecord(id, input, coverRelPath)
        for (const assetPath of result.obsoletePaths) {
          deleteBestEffort(assetPath)
        }
      })
      return true
    },
    clearMetadata(id): boolean {
      const video = readVideoById(id)
      if (!video) return true

      runInCoordinatedChange(() => {
        const result = clearMetadataRecord(id)
        for (const assetPath of new Set([...result.obsoletePaths, video.cover_path])) {
          deleteBestEffort(assetPath)
        }
      })
      return true
    },
    markScrapeSucceeded(id): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')
      recordScrapeSucceeded(id)
      return true
    },
    delete(id): boolean {
      const video = readVideoById(id)
      if (!video) throw new Error('Video record not found')

      runInCoordinatedChange(() => {
        for (const file of readVideoFiles(id)) {
          if (fileExists(file.file_path)) {
            try {
              unlinkSync(file.file_path)
            } catch (err) {
              throw new Error(`Failed to delete video file: ${(err as Error).message}`)
            }
          }
        }

        for (const assetPath of purgeVideoRecord(id).obsoletePaths) {
          deleteBestEffort(assetPath)
        }
      })
      return true
    },
    setRating(id, ratingValue): boolean {
      writeRating(id, ratingValue)
      return true
    },
    setPrimaryFile(videoId, fileId): boolean {
      if (!readVideoById(videoId)) throw new Error('Video not found')
      writePrimaryFile(videoId, fileId)
      return true
    },
    deleteFile(videoId, fileId): boolean {
      if (!readVideoById(videoId)) throw new Error('影片不存在')

      const file = readVideoFileById(fileId)
      if (!file || file.video_id !== videoId) {
        throw new Error('文件不属于当前影片')
      }

      const files = readVideoFiles(videoId)
      if (files.length <= 1) {
        throw new Error('至少需要保留一个文件')
      }
      if (file.is_primary) {
        throw new Error('主文件不能直接删除，请先设置其它文件为主文件')
      }

      if (fileExists(file.file_path)) {
        try {
          unlinkSync(file.file_path)
        } catch (err) {
          throw new Error(`Failed to delete video file: ${(err as Error).message}`)
        }
      }

      removeFileRecord(fileId)
      return true
    },
    correctImport(id, codeRaw): CorrectImportResult {
      const newCode = codeRaw.trim()
      if (!newCode) throw new Error('Code cannot be empty')

      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      if (newCode === video.code) {
        return { code: newCode, previousCode: video.code }
      }

      const existing = readVideoByCode(newCode)
      if (existing && existing.id !== id) {
        const primary = readPrimaryVideoFile(existing.id)
        if (!primary || !fileExists(primary.file_path)) {
          if (primary) removeFileRecord(primary.id)
          mergeIntoExistingCode(id, existing.id)
          return { code: newCode, previousCode: video.code, mergedIntoId: existing.id }
        }
        throw new Error(`Code ${newCode} already exists and its source file is still present`)
      }

      renameCode(id, newCode)
      return { code: newCode, previousCode: video.code }
    },
    async importSample(id, input): Promise<VideoAsset> {
      const video = readVideoById(id)
      if (!video) throw new Error('Video not found')

      if (input.source === 'file') {
        const sourcePath = input.sourcePath?.trim()
        if (!sourcePath) throw new Error('请选择本地图片文件')
        return coordinateDatabaseChange(() => {
          const localPath = importSampleAsset(video.code, sourcePath)
          return addSampleAsset(id, { localPath })
        })
      }

      const rawUrl = input.remoteUrl?.trim()
      if (!rawUrl) throw new Error('请输入样张链接')
      let parsed: URL
      try {
        parsed = new URL(rawUrl)
      } catch {
        throw new Error('样张链接格式不正确')
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('样张链接仅支持 http/https')
      }
      const remoteUrl = parsed.toString()
      return coordinateDatabaseChange(async () => {
        const buf = await fetchRemoteBuffer(remoteUrl)
        const [localPath] = await downloadSamples(video.code, [remoteUrl], async () => buf)
        if (!localPath) throw new Error('样张链接下载失败')
        return addSampleAsset(id, { remoteUrl, localPath })
      })
    },
    deleteSample(id, assetId): boolean {
      runInCoordinatedChange(() => {
        const result = deleteSampleAsset(id, assetId)
        for (const localPath of result.obsoletePaths) deleteBestEffort(localPath)
      })
      return true
    },
    setPoster(id, posterPath): boolean {
      writePoster(id, posterPath)
      return true
    },
    addManualTag(id, name): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      writeManualTag(id, name)
      return true
    },
    removeManualTag(id, tagId): boolean {
      if (!readVideoById(id)) throw new Error('Video not found')
      deleteManualTag(id, tagId)
      return true
    }
  }
}

export const videoMaintenanceService = createVideoMaintenanceService()
