import type { LibraryScanFileAuditEntry } from '@shared/libraryTypes'

export type ScanAuditTab = 'failed' | 'all' | 'added_updated' | 'skipped' | 'changes'

const AUDIT_ROW_GAP = 8
const AUDIT_STANDARD_ROW_HEIGHT = 64
const AUDIT_COMPACT_ROW_HEIGHT = 40

export function auditRowHeight(activeTab: ScanAuditTab): number {
  return (
    (activeTab === 'skipped' ? AUDIT_COMPACT_ROW_HEIGHT : AUDIT_STANDARD_ROW_HEIGHT) +
    AUDIT_ROW_GAP
  )
}

export function isCompactAuditRow(
  activeTab: ScanAuditTab,
  outcome?: LibraryScanFileAuditEntry['outcome']
): boolean {
  return activeTab === 'skipped' && outcome === 'skipped'
}

export function shouldVirtualizeAuditRows(activeTab: ScanAuditTab, itemCount: number): boolean {
  return activeTab !== 'failed' && itemCount > 8
}
