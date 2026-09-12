import type { LibraryScanAudit, LibraryScanFileAuditEntry, LibraryScanResourceAuditEntry } from '@shared/libraryTypes'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNfoAudit(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (
    !['imported', 'skipped', 'warning', 'pending-candidate', 'identity-conflict'].includes(
      String(value.disposition)
    )
  ) {
    return false
  }
  if (
    value.pendingScrapeId != null &&
    (!Number.isSafeInteger(value.pendingScrapeId) || Number(value.pendingScrapeId) <= 0)
  ) {
    return false
  }
  if (
    value.pendingIdentityId != null &&
    (!Number.isSafeInteger(value.pendingIdentityId) || Number(value.pendingIdentityId) <= 0)
  ) {
    return false
  }
  return (
    value.warnings == null ||
    (Array.isArray(value.warnings) &&
      value.warnings.length <= 20 &&
      value.warnings.every(
        (warning) =>
          isRecord(warning) &&
          hasText(warning.code) &&
          warning.code.length <= 64 &&
          hasText(warning.message) &&
          warning.message.length <= 500
      ))
  )
}

export function isFileEntry(value: unknown): value is LibraryScanFileAuditEntry {
  if (!isRecord(value) || !Number.isSafeInteger(value.rootId) || Number(value.rootId) <= 0) {
    return false
  }
  if (!hasText(value.filePath)) return false
  if (value.sourceKind !== 'local' && value.sourceKind !== 'strm') return false
  if (value.nfo != null && !isNfoAudit(value.nfo)) return false
  return [
    'added',
    'updated',
    'pending',
    'skipped',
    'unrecognized',
    'strm_failure',
    'processing_failure'
  ].includes(String(value.outcome))
}

export function isResourceEntry(value: unknown): value is LibraryScanResourceAuditEntry {
  return (
    isRecord(value) &&
    Number.isInteger(value.resourceId) &&
    Number.isInteger(value.videoId) &&
    hasText(value.videoCode) &&
    (value.sourcePath === null || hasText(value.sourcePath))
  )
}

export function normalizeAudit(value: unknown): LibraryScanAudit | null {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) return null
  if (!Number.isSafeInteger(value.libraryId) || Number(value.libraryId) <= 0) return null
  if (!hasText(value.runId)) return null
  if (!Number.isSafeInteger(value.configRevision) || Number(value.configRevision) < 0) return null
  if (!['manual', 'startup', 'interval', 'resume'].includes(String(value.trigger))) return null
  if (!['success', 'completed_with_errors', 'cancelled', 'failed'].includes(String(value.status))) {
    return null
  }
  if (!hasText(value.startedAt) || !hasText(value.finishedAt)) return null
  if (!Array.isArray(value.files) || !value.files.every(isFileEntry)) return null
  if (!Array.isArray(value.removedResources) || !value.removedResources.every(isResourceEntry)) {
    return null
  }
  if (!Array.isArray(value.promotedResources) || !value.promotedResources.every(isResourceEntry)) {
    return null
  }
  if (!Array.isArray(value.deletedVideos) || !Array.isArray(value.pendingGroups)) return null
  return value as unknown as LibraryScanAudit
}
