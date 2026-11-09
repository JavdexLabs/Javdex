import type { SubtitleTaskView } from '@shared/desktop/subtitleTasks'

export type SubtitleTaskFilter = 'all' | 'active' | 'attention' | 'finished'
export function subtitleNeedsAttention(task: Pick<SubtitleTaskView, 'status'>): boolean {
  return task.status === 'failed' || task.status === 'awaiting-save'
}
export function subtitleIsRunning(task: Pick<SubtitleTaskView, 'status'>): boolean {
  return task.status === 'running' || task.status === 'saving'
}
export function matchesSubtitleFilter(task: Pick<SubtitleTaskView, 'status'>, filter: SubtitleTaskFilter): boolean {
  if (filter === 'attention') return subtitleNeedsAttention(task)
  if (filter === 'active') return ['queued', 'running', 'saving', 'paused'].includes(task.status)
  if (filter === 'finished') return ['completed', 'cancelled'].includes(task.status)
  return true
}
/** Bilingual completion is limited by translation, not just recognition. */
export function subtitleProgress(task: SubtitleTaskView): number | null {
  if (!Number.isFinite(task.duration) || task.duration <= 0) return null
  const seconds = task.output === 'japanese' ? task.recognizedSeconds : Math.min(task.recognizedSeconds, task.translatedSeconds)
  return Math.max(0, Math.min(100, Math.floor(seconds / task.duration * 100)))
}
