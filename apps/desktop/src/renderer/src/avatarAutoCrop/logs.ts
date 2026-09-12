import type { BatchLogEntry } from '@shared/batchScrapeTypes'

export const AVATAR_LOG_LIMIT = 200
export interface AvatarLogState {
  logs: BatchLogEntry[]
  totalLogCount: number
  shortenedLogCount: number
}

function preview(value: string, limit: number): string {
  if (value.length <= limit) return value
  let prefix = value.slice(0, limit - 1)
  const last = prefix.charCodeAt(prefix.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) prefix = prefix.slice(0, -1)
  return prefix + '…'
}

export function appendAvatarLog(state: AvatarLogState, entry: BatchLogEntry): AvatarLogState {
  const bounded = { ...entry, time: preview(entry.time, 64), code: preview(entry.code, 128), message: preview(entry.message, 1024) }
  const shortened = bounded.time !== entry.time || bounded.code !== entry.code || bounded.message !== entry.message
  return {
    logs: [...state.logs.slice(-(AVATAR_LOG_LIMIT - 1)), bounded],
    totalLogCount: state.totalLogCount + 1,
    shortenedLogCount: state.shortenedLogCount + Number(shortened)
  }
}

export function avatarLogNotice(state: AvatarLogState): string {
  const omitted = state.totalLogCount - state.logs.length
  return `日志仅保留最近 ${AVATAR_LOG_LIMIT} 条。${omitted > 0 ? `已省略 ${omitted} 条较早日志。` : ''}${state.shortenedLogCount > 0 ? `${state.shortenedLogCount} 条日志的长文本已截断。` : ''}`
}
