import { getDb } from '@library/db/database'
import { readScanAuditHeader } from '@library/scan/scanAuditReadHeader'
import { createScanAuditReadIndex } from '@library/scan/scanAuditReadIndex'
import { SCAN_AUDIT_READ_LIMITS } from '@library/scan/scanAuditReadPolicy'
import { readLibraryScanAudit } from '@library/scan/libraryScanAuditStore'
import { getLatestLibraryScanSnapshot } from '@library/db/libraryScanRepo'
import type { ScanAuditIndexQuery, ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import { structuredError } from '@shared/protocol/errors'

function databasePath(): string {
  const name = getDb().name
  if (!name || name === ':memory:') {
    throw structuredError('INVALID_INPUT', '扫描审计分页需要文件数据库')
  }
  return name
}

export function catalogScanAuditHeader(libraryId: number) {
  return readScanAuditHeader(getDb(), libraryId)
}

export function catalogScanAuditGet(libraryId: number) {
  return readLibraryScanAudit(libraryId)
}

export function catalogScanLatest(libraryId: number) {
  return getLatestLibraryScanSnapshot(libraryId)
}

export function catalogScanAuditPage(
  libraryId: number,
  query: Omit<ScanAuditIndexQuery, 'section'> & { section?: ScanAuditIndexQuery['section'] }
) {
  const header = catalogScanAuditHeader(libraryId)
  if (!header.snapshot) {
    return { snapshot: null, section: query.section ?? 'files', items: [], total: 0, limit: query.limit ?? 50, offset: query.offset ?? 0 }
  }
  const index = createScanAuditReadIndex(databasePath(), header.snapshot, SCAN_AUDIT_READ_LIMITS)
  try {
    return index.readPage({
      section: query.section ?? 'files',
      outcome: query.outcome,
      attention: query.attention,
      limit: Math.min(query.limit ?? 50, 100),
      offset: query.offset ?? 0
    })
  } finally {
    index.dispose()
  }
}

export function catalogScanAuditViewPage(libraryId: number, query: ScanAuditViewQuery) {
  const header = catalogScanAuditHeader(libraryId)
  if (!header.snapshot) {
    throw structuredError('INVALID_INPUT', '没有可分页的扫描审计快照')
  }
  const index = createScanAuditReadIndex(databasePath(), header.snapshot, SCAN_AUDIT_READ_LIMITS, {
    views: true
  })
  try {
    return index.readViewPage({
      ...query,
      limit: Math.min(query.limit ?? 50, 100)
    })
  } finally {
    index.dispose()
  }
}
