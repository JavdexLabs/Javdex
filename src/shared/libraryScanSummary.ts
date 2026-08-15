import type {
  LibraryScanStatus,
  LibraryScanSummary,
  LibraryScanTrigger,
  StrmScanFailure,
  StrmScanFailureCode
} from './libraryTypes'

const SCAN_TRIGGERS = new Set<LibraryScanTrigger>(['manual', 'startup', 'interval', 'resume'])
const SCAN_STATUSES = new Set<LibraryScanStatus>([
  'success',
  'completed_with_errors',
  'cancelled',
  'failed'
])
const STRM_FAILURE_MESSAGES: Record<StrmScanFailureCode, string> = {
  too_large: 'STRM 文件超过 1 MiB',
  invalid_utf8: 'STRM 文件不是有效的 UTF-8 文本',
  missing_target: 'STRM 文件没有有效目标',
  multiple_targets: 'STRM 文件包含多个目标',
  unsupported_target: 'STRM 目标协议不受支持',
  read_failed: '无法读取 STRM 文件'
}
const STRM_FAILURE_CODES = new Set<StrmScanFailureCode>(
  Object.keys(STRM_FAILURE_MESSAGES) as StrmScanFailureCode[]
)
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"']+/gi
const PROTOCOL_LINK_PATTERN = /(?:magnet:\?|ed2k:\/\/)[^\r\n]*/gi

export function sanitizeLibraryScanError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '扫描失败'
  const sanitized = raw
    .replace(PROTOCOL_LINK_PATTERN, (match) =>
      match.toLowerCase().startsWith('magnet:?')
        ? 'magnet:[参数已隐藏]'
        : 'ed2k:[参数已隐藏]'
    )
    .replace(HTTP_URL_PATTERN, (match) => {
      try {
        const url = new URL(match)
        url.username = ''
        url.password = ''
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

function normalizeStrmFailures(value: unknown): StrmScanFailure[] {
  if (!Array.isArray(value)) return []
  const failures: StrmScanFailure[] = []
  for (const item of value) {
    if (failures.length >= 50) break
    if (!isRecord(item) || typeof item.sourcePath !== 'string') continue
    const code = item.code as StrmScanFailureCode
    if (!STRM_FAILURE_CODES.has(code)) continue
    failures.push({
      sourcePath: item.sourcePath,
      code,
      message: STRM_FAILURE_MESSAGES[code]
    })
  }
  return failures
}

export function normalizeLibraryScanSummary(value: unknown): LibraryScanSummary | null {
  if (!isRecord(value)) return null
  if (!SCAN_TRIGGERS.has(value.trigger as LibraryScanTrigger)) return null
  if (!SCAN_STATUSES.has(value.status as LibraryScanStatus)) return null
  if (typeof value.startedAt !== 'string' || typeof value.finishedAt !== 'string') return null

  const allFailureCount = Array.isArray(value.strmFailures) ? value.strmFailures.length : 0
  const strmFailures = normalizeStrmFailures(value.strmFailures)
  const omittedStrmFailures =
    count(value.omittedStrmFailures) + Math.max(0, allFailureCount - strmFailures.length)

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
    ...(strmFailures.length > 0 ? { strmFailures } : {}),
    ...(strmFailures.length > 0 || omittedStrmFailures > 0 ? { omittedStrmFailures } : {}),
    errorSummary:
      value.errorSummary == null ? null : sanitizeLibraryScanError(value.errorSummary)
  }
}
