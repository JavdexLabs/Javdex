import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { LibraryScanAudit } from '@shared/libraryTypes'
import { normalizeAudit } from './libraryScanAuditValidation'
import { getDb } from '@library/db/database'
import { readScanAuditSource } from '@library/db/scanAuditSource'
import { resolveLibraryUserDataPath } from '@library/runtime/host'

function auditFilePath(libraryId: number): string {
  return path.join(resolveLibraryUserDataPath(), `library-scan-audit-${libraryId}.json`)
}

function readPersistedAudit(libraryId: number): LibraryScanAudit | null | undefined {
  try {
    const source = readScanAuditSource(getDb(), { libraryId, latest: true }, 'body')
    if (!source) return null
    const audit = normalizeAudit(JSON.parse(source.body))
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
