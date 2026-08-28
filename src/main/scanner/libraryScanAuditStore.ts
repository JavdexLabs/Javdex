import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { readTestUserDataPath } from '@shared/appIdentity'
import type {
  LibraryScanAudit,
  LibraryScanFileAuditEntry,
  LibraryScanResourceAuditEntry
} from '@shared/libraryTypes'
import { getDb } from '../db/database'

function auditFilePath(libraryId: number): string {
  const userData = readTestUserDataPath() ?? (app?.getPath ? app.getPath('userData') : undefined)
  if (!userData) throw new Error('Electron app userData path is unavailable')
  return path.join(userData, `library-scan-audit-${libraryId}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isFileEntry(value: unknown): value is LibraryScanFileAuditEntry {
  if (!isRecord(value) || !Number.isSafeInteger(value.rootId) || Number(value.rootId) <= 0) {
    return false
  }
  if (!hasText(value.filePath)) return false
  if (value.sourceKind !== 'local' && value.sourceKind !== 'strm') return false
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

function isResourceEntry(value: unknown): value is LibraryScanResourceAuditEntry {
  return (
    isRecord(value) &&
    Number.isInteger(value.resourceId) &&
    Number.isInteger(value.videoId) &&
    hasText(value.videoCode) &&
    (value.sourcePath === null || hasText(value.sourcePath))
  )
}

function normalizeAudit(value: unknown): LibraryScanAudit | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null
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

function readPersistedAudit(libraryId: number): LibraryScanAudit | null | undefined {
  try {
    const row = getDb()
      .prepare(
        `SELECT audit_json
           FROM library_scan_runs
          WHERE library_id = ? AND audit_json IS NOT NULL
          ORDER BY started_at DESC, id DESC
          LIMIT 1`
      )
      .get(libraryId) as { audit_json: string } | undefined
    if (!row) return null
    const audit = normalizeAudit(JSON.parse(row.audit_json))
    return audit?.libraryId === libraryId ? audit : null
  } catch (error) {
    if ((error as Error).message.includes('Database not initialised')) return undefined
    return null
  }
}

export function readLibraryScanAudit(libraryId: number): LibraryScanAudit | null {
  if (!Number.isSafeInteger(libraryId) || libraryId <= 0) return null
  const persisted = readPersistedAudit(libraryId)
  if (persisted !== undefined) return persisted
  try {
    const audit = normalizeAudit(JSON.parse(fs.readFileSync(auditFilePath(libraryId), 'utf8')))
    return audit?.libraryId === libraryId ? audit : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

export function writeLibraryScanAudit(audit: LibraryScanAudit): void {
  const file = auditFilePath(audit.libraryId)
  const temporaryFile = `${file}.tmp-${process.pid}`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporaryFile, JSON.stringify(audit), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporaryFile, file)
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600)
  } catch (error) {
    try {
      fs.rmSync(temporaryFile, { force: true })
    } catch {
      // Preserve the original persistence error.
    }
    throw new Error(`保存扫描审计失败：${(error as Error).message}`)
  }
}

export function libraryScanAuditContainsPath(audit: LibraryScanAudit, filePath: string): boolean {
  const normalized = path.resolve(filePath).toLowerCase()
  const matches = (candidate: string): boolean => path.resolve(candidate).toLowerCase() === normalized
  return (
    audit.files.some((item) => matches(item.filePath)) ||
    audit.removedResources.some((item) => item.sourcePath != null && matches(item.sourcePath)) ||
    audit.promotedResources.some((item) => item.sourcePath != null && matches(item.sourcePath))
  )
}
