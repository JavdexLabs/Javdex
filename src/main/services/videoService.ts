import fs from 'node:fs'
import type { CorrectImportResult, VideoAsset, VideoEditInput, VideoSampleImportInput } from '@shared/types'
import {
  addVideoSampleAsset,
  addManualVideoTag,
  clearVideoMetadataRecord,
  deleteVideoSampleAsset,
  editVideoRecord,
  getVideoByCode,
  getVideoById,
  mergeVideoIntoExistingCode,
  purgeVideo,
  removeManualVideoTag,
  renameVideoCode
} from '../db/videoRepo'
import { deleteAsset, downloadSamples, importCoverFromFile, importSampleFromFile } from './assetService'
import { scrapeBrowser } from '../scrapers/scrapeBrowser'

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
  const [localPath] = await downloadSamples(video.code, [remoteUrl], (url) =>
    scrapeBrowser.fetchBuffer(url)
  )
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
    if (!fs.existsSync(existing.file_path)) {
      mergeVideoIntoExistingCode(id, existing.id, video.file_path, video.file_size)
      return { code: newCode, previousCode: video.code, mergedIntoId: existing.id }
    }
    throw new Error(`Code ${newCode} already exists and its source file is still present`)
  }

  renameVideoCode(id, newCode)
  return { code: newCode, previousCode: video.code }
}

export function deleteVideoWithFile(id: number): void {
  const video = getVideoById(id)
  if (!video) throw new Error('Video record not found')

  if (fs.existsSync(video.file_path)) {
    try {
      fs.unlinkSync(video.file_path)
    } catch (err) {
      throw new Error(`Failed to delete video file: ${(err as Error).message}`)
    }
  }

  purgeVideo(id)
}
