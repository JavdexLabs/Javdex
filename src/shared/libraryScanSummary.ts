import type {
  LibraryScanStatus,
  LibraryScanSummary,
  LibraryScanTrigger
} from './libraryTypes'

const SCAN_TRIGGERS = new Set<LibraryScanTrigger>(['manual', 'startup', 'interval', 'resume'])
const SCAN_STATUSES = new Set<LibraryScanStatus>(['success', 'cancelled', 'failed'])
const RESOURCE_URL_PATTERN = /(?:https?:\/\/|magnet:\?)[^\s<>"']+/gi

export function sanitizeLibraryScanError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '扫描失败'
  const sanitized = raw.replace(RESOURCE_URL_PATTERN, (match) => {
    if (match.toLowerCase().startsWith('magnet:?')) return 'magnet:[参数已隐藏]'
    try {
      const url = new URL(match)
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return '[资源链接已隐藏]'
    }
  })
  return (sanitized.trim() || '扫描失败').slice(0, 500)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

export function normalizeLibraryScanSummary(value: unknown): LibraryScanSummary | null {
  if (!isRecord(value)) return null
  if (!SCAN_TRIGGERS.has(value.trigger as LibraryScanTrigger)) return null
  if (!SCAN_STATUSES.has(value.status as LibraryScanStatus)) return null
  if (typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return null

  return {
    trigger: value.trigger as LibraryScanTrigger,
    startedAt: value.startedAt,
    finishedAt: value.finishedAt,
    status: value.status as LibraryScanStatus,
    scannedFiles: count(value.scannedFiles),
    resourcesAdded: count(value.resourcesAdded),
    resourcesUpdated: count(value.resourcesUpdated),
    resourcesRemoved: count(value.resourcesRemoved),
    primaryResourcesPromoted: count(value.primaryResourcesPromoted),
    videosDeleted: count(value.videosDeleted),
    skippedFiles: count(value.skippedFiles),
    failedFiles: count(value.failedFiles),
    pendingScanGroups: count(value.pendingScanGroups),
    pendingScanResources: count(value.pendingScanResources),
    offlineFolders: Array.isArray(value.offlineFolders)
      ? value.offlineFolders.filter((item): item is string => typeof item === 'string')
      : [],
    errorSummary:
      value.errorSummary == null ? null : sanitizeLibraryScanError(value.errorSummary)
  }
}
