import type { PlaybackTarget } from './playback'

export type SubtitleTaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'saving' | 'awaiting-save' | 'completed' | 'cancelled'
export interface SubtitleTaskView {
  id: string
  title: string
  target: PlaybackTarget
  audioIndex: number
  output: 'bilingual' | 'japanese'
  status: SubtitleTaskStatus
  duration: number
  recognizedSeconds: number
  translatedSeconds: number
  error: string | null
  outputName: string | null
}
export interface SubtitleTasksSnapshot { tasks: SubtitleTaskView[]; error: string | null }
export interface SubtitleFileView {
  path: string
  name: string
  source: 'directory' | 'linked'
  available: boolean
  error: string | null
}
export interface SubtitleFilesSnapshot { files: SubtitleFileView[]; error: string | null }
export interface SubtitlePreparation {
  duration: number | null
  error: string | null
  audio: Array<{ index: number; label: string }>
  subtitles: string[]
}
export type SubtitleTaskCommand =
  | { action: 'enqueue'; target: PlaybackTarget; audioIndex: number; output: 'bilingual' | 'japanese' }
  | { action: 'resume' | 'pause' | 'cancel' | 'retry-save' | 'save-as' | 'export-srt' | 'remove' | 'delete-output'; id: string }
