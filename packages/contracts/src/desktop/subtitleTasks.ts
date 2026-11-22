import type { PlaybackTarget } from './playback'

export type SubtitleTaskStatus = 'queued' | 'running' | 'paused' | 'failed' | 'saving' | 'awaiting-save' | 'completed'
export const MAX_SUBTITLE_TASKS = 10000
export const subtitleBulkOperations = ['resume', 'pause', 'remove-active', 'clear-completed'] as const
export type SubtitleBulkOperation = typeof subtitleBulkOperations[number]
export function canApplySubtitleBulkOperation(status: SubtitleTaskStatus, operation: SubtitleBulkOperation): boolean {
  switch (operation) {
    case 'resume': return status === 'paused'
    case 'pause': return status === 'queued' || status === 'running'
    case 'remove-active': return status === 'queued' || status === 'running' || status === 'paused'
    case 'clear-completed': return status === 'completed'
  }
}
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
  existingFiles: SubtitleOutputs
}
export type SubtitleTaskCommand =
  | { action: 'bulk'; operation: SubtitleBulkOperation; ids: string[] }
  | { action: 'enqueue'; target: PlaybackTarget; audioIndex: number; output: 'bilingual' | 'japanese'; replaceRevision?: string }
  | { action: 'resume' | 'pause' | 'retry-save' | 'save-as' | 'export-srt' | 'remove' | 'delete-output'; id: string }

export type SubtitleOutput = SubtitleTaskView['output']
export type SubtitleOutputs = Partial<Record<SubtitleOutput, { name: string; revision: string | null }>>
export interface BatchSubtitlePreview {
  videoId: number
  code: string
  resources: Array<{ id: number; name: string; primary: boolean; error?: string }>
  resourceId: number | null
  signature: string
  audio: Array<{ index: number; label: string; language: string }>
  suggestedAudio: number | null
  existingFiles: SubtitleOutputs
  jobs: Array<Pick<SubtitleTaskView, 'id' | 'audioIndex' | 'output' | 'status'>>
  error?: string
}
export interface BatchSubtitleItem {
  videoId: number
  resourceId: number
  signature: string
  audioIndex: number
  resumeId?: string
  replaceRevision?: string
}
export interface BatchSubtitleResult {
  videoId: number
  outcome: 'queued' | 'resumed' | 'skipped' | 'failed'
  message: string
}
