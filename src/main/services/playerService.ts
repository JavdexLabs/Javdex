import { shell } from 'electron'
import fs from 'node:fs'
import { getVideoById } from '../db/videoRepo'
import type { PlayResult } from '@shared/types'

/**
 * Open a video in the OS default player via the system shell.
 * Reports fileMissing when the path is gone.
 */
export async function playVideo(videoId: number): Promise<PlayResult> {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频记录不存在' }

  if (!fs.existsSync(video.file_path)) {
    return { ok: false, fileMissing: true, error: '文件不存在' }
  }

  // shell.openPath returns an empty string on success, error message otherwise.
  const errMsg = await shell.openPath(video.file_path)
  if (errMsg) {
    return { ok: false, error: errMsg }
  }

  return { ok: true }
}

/** Reveal the file in the system file explorer. */
export function revealVideo(videoId: number): PlayResult {
  const video = getVideoById(videoId)
  if (!video) return { ok: false, error: '视频记录不存在' }
  if (!fs.existsSync(video.file_path)) {
    return { ok: false, fileMissing: true, error: '文件不存在' }
  }
  shell.showItemInFolder(video.file_path)
  return { ok: true }
}
