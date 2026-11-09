import { ROUTE_PATH } from '../listView/routePaths'

export const TASK_TABS = ['overview', 'pending', 'scan', 'scrape', 'subtitles'] as const
export type TaskTab = typeof TASK_TABS[number]
export const TASK_LABELS: Record<TaskTab, string> = { overview: '概览', pending: '待确认', scan: '扫描', scrape: '刮削', subtitles: '字幕' }
export function taskCenterPath(tab: TaskTab = 'overview', status?: string): string {
  if (tab === 'pending') return ROUTE_PATH.pending
  const params = new URLSearchParams()
  if (tab !== 'overview') params.set('tab', tab)
  if (status) params.set('status', status)
  return `${ROUTE_PATH.tasks}${params.size ? `?${params}` : ''}`
}
export function parseTaskTab(search: string): Exclude<TaskTab, 'pending'> {
  const value = new URLSearchParams(search).get('tab')
  return value === 'scan' || value === 'scrape' || value === 'subtitles' ? value : 'overview'
}
