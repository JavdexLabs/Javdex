import fs from 'node:fs'
import type { CorrectImportResult, VideoAsset, VideoDetail, VideoEditInput, VideoSampleImportInput } from '@shared/types'
import {
  addVideoSampleAsset,
  addManualVideoTag,
  clearVideoMetadataRecord,
  deleteVideoSampleAsset,
  editVideoRecord,
  getVideoByCode,
  getVideoById,
  getVideoDetail,
  getVideoFileById,
  getPrimaryVideoFile,
  listVideoFiles,
  markScrapeSucceeded,
  mergeVideoIntoExistingCode,
  purgeVideo,
  removeManualVideoTag,
  removeVideoFileRecord,
  renameVideoCode,
  setPrimaryVideoFile
} from '../db/videoRepo'
import { deleteAsset, downloadSamples, importCoverFromFile, importSampleFromFile } from './assetService'
import { fetchRemoteImageBuffer } from './remoteImageFetch'
import { resolveVideoDisplayDurationSeconds } from '../scanner/videoDuration'

export function getVideoDetailForUi(id: number): VideoDetail | null {
  const detail = getVideoDetail(id)
  if (!detail) return null
  const primary = detail.files[0]
  const resolved_duration_seconds = resolveVideoDisplayDurationSeconds({
    duration_seconds: detail.duration_seconds,
    file_duration_seconds: primary?.file_duration_seconds ?? null
  })
  return { ...detail, resolved_duration_seconds }
}

export function editVideo(id: number, input: VideoEditInput): void {
  const video = getVideoById(id)
  if (!video) throw new Error('Video not found')

  const coverRelPath = input.coverSourcePath
    ? importCoverFromFile(video.code, input.coverSourcePath)
    : undefined

  editVideoRecord(id, input, coverRelPath)

  if (coverRelPath && video.cover_path && video.cover_path !== coverRelPath) {
    deleteAsset(video.cover_path)
  }
}

export function clearVideoMetadata(id: number): void {
  const video = getVideoById(id)
  if (!video) return

  clearVideoMetadataRecord(id)
  deleteAsset(video.cover_path)
}

export function markVideoScrapeSuccess(id: number): void {
  const video = getVideoById(id)
  if (!video) throw new Error('Video not found')
  markScrapeSucceeded(id)
}

export async function importVideoSample(id: number, input: VideoSampleImportInput): Promise<VideoAsset> {
  const video = getVideoById(id)
  if (!video) throw new Error('Video not found')

  if (input.source === 'file') {
    const sourcePath = input.sourcePath?.trim()
    if (!sourcePath) throw new Error('请选择本地图片文件')
    const localPath = importSampleFromFile(video.code, sourcePath)
    return addVideoSampleAsset(id, { localPath })
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
  const buf = await fetchRemoteImageBuffer(remoteUrl)
  const [localPath] = await downloadSamples(video.code, [remoteUrl], async () => buf)
  if (!localPath) throw new Error('样张链接下载失败')
  return addVideoSampleAsset(id, { remoteUrl, localPath })
}

export function deleteVideoSample(id: number, assetId: number): void {
  const localPath = deleteVideoSampleAsset(id, assetId)
  deleteAsset(localPath)
}

export function addVideoManualTag(id: number, name: string): void {
  if (!getVideoById(id)) throw new Error('Video not found')
  addManualVideoTag(id, name)
}

export function removeVideoManualTag(id: number, tagId: number): void {
  if (!getVideoById(id)) throw new Error('Video not found')
  removeManualVideoTag(id, tagId)
}

export function correctVideoCode(id: number, codeRaw: string): CorrectImportResult {
  const newCode = codeRaw.trim()
  if (!newCode) throw new Error('Code cannot be empty')

  const video = getVideoById(id)
  if (!video) throw new Error('Video not found')

  if (newCode === video.code) {
    return { code: newCode, previousCode: video.code }
  }

  const existing = getVideoByCode(newCode)
  if (existing && existing.id !== id) {
    const primary = getPrimaryVideoFile(existing.id)
    if (!primary || !fs.existsSync(primary.file_path)) {
      if (primary) removeVideoFileRecord(primary.id)
      mergeVideoIntoExistingCode(id, existing.id)
      return { code: newCode, previousCode: video.code, mergedIntoId: existing.id }
    }
    throw new Error(`Code ${newCode} already exists and its source file is still present`)
  }

  renameVideoCode(id, newCode)
  return { code: newCode, previousCode: video.code }
}

export function setVideoPrimaryFile(videoId: number, fileId: number): void {
  if (!getVideoById(videoId)) throw new Error('Video not found')
  setPrimaryVideoFile(videoId, fileId)
}

export function deleteVideoFile(videoId: number, fileId: number): void {
  if (!getVideoById(videoId)) throw new Error('影片不存在')

  const file = getVideoFileById(fileId)
  if (!file || file.video_id !== videoId) {
    throw new Error('文件不属于当前影片')
  }

  const files = listVideoFiles(videoId)
  if (files.length <= 1) {
    throw new Error('至少需要保留一个文件')
  }
  if (file.is_primary) {
    throw new Error('主文件不能直接删除，请先设置其它文件为主文件')
  }

  if (fs.existsSync(file.file_path)) {
    try {
      fs.unlinkSync(file.file_path)
    } catch (err) {
      throw new Error(`Failed to delete video file: ${(err as Error).message}`)
    }
  }

  removeVideoFileRecord(fileId)
}

export function deleteVideoWithFile(id: number): void {
  const video = getVideoById(id)
  if (!video) throw new Error('Video record not found')

  for (const file of listVideoFiles(id)) {
    if (fs.existsSync(file.file_path)) {
      try {
        fs.unlinkSync(file.file_path)
      } catch (err) {
        throw new Error(`Failed to delete video file: ${(err as Error).message}`)
      }
    }
  }

  purgeVideo(id)
}
