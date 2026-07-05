import { shell } from 'electron'
import fs from 'node:fs'
import { getPrimaryVideoFile, getVideoById, getVideoFileById } from '../db/videoRepo'
import type { PlayResult } from '@shared/types'

async function openFilePath(filePath: string): Promise<PlayResult> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, fileMissing: true, error: '文件不存在' }
  }

  const errMsg = await shell.openPath(filePath)
  if (errMsg) {
    return { ok: false, error: errMsg }
  }

  return { ok: true }
}

/**
 * Open a video in the OS default player via the system shell.
 * Reports fileMissing when the path is gone.
 */
export async function playVideo(videoId: number): Promise<PlayResult> {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频记录不存在' }

  const file = getPrimaryVideoFile(videoId)
  if (!file) return { ok: false, fileMissing: true, error: '文件不存在' }

  return openFilePath(file.file_path)
}

export async function playVideoFile(fileId: number): Promise<PlayResult> {
  const file = getVideoFileById(fileId)
  if (!file) return { ok: false, error: '文件记录不存在' }
  return openFilePath(file.file_path)
}

/** Reveal the file in the system file explorer. */
export function revealVideo(videoId: number): PlayResult {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频记录不存在' }
  const file = getPrimaryVideoFile(videoId)
  if (!file || !fs.existsSync(file.file_path)) {
    return { ok: false, fileMissing: true, error: '文件不存在' }
  }
  shell.showItemInFolder(file.file_path)
  return { ok: true }
}

export function revealVideoFile(fileId: number): PlayResult {
  const file = getVideoFileById(fileId)
  if (!file) return { ok: false, error: '文件记录不存在' }
  if (!fs.existsSync(file.file_path)) {
    return { ok: false, fileMissing: true, error: '文件不存在' }
  }
  shell.showItemInFolder(file.file_path)
  return { ok: true }
}
