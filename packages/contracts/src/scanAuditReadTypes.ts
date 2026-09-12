import type { LibraryScanSummary } from './libraryTypes'

export const SCAN_AUDIT_SECTIONS = ['files', 'removedResources', 'promotedResources', 'deletedVideos', 'pendingGroups'] as const
export const SCAN_AUDIT_OUTCOMES = ['added', 'updated', 'pending', 'skipped', 'unrecognized', 'strm_failure', 'processing_failure'] as const
export type ScanAuditSection = typeof SCAN_AUDIT_SECTIONS[number]
export interface ScanAuditSnapshotIdentity { libraryId: number; runId: string; finishedAt: string }
export interface ScanAuditIndexLimits { sourceBytes: number; indexBytes: number; pageBytes: number }
export interface ScanAuditIndexQuery {
  section: ScanAuditSection
  outcome?: typeof SCAN_AUDIT_OUTCOMES[number]
  attention?: boolean
  limit?: number
  offset?: number
}
export interface ScanAuditIndexPage {
  snapshot: ScanAuditSnapshotIdentity
  section: ScanAuditSection
  items: Array<{ ordinal: number; entry: Record<string, unknown> }>
  total: number
  limit: number
  offset: number
}
export interface ScanAuditReadHeader {
  summary: LibraryScanSummary | null
  snapshot: ScanAuditSnapshotIdentity | null
  unrecognizedCount: number
}

export type ScanAuditViewTab = 'failed' | 'all' | 'added_updated' | 'skipped' | 'changes'
export interface ScanAuditViewQuery {
  tab: ScanAuditViewTab
  outcome?: typeof SCAN_AUDIT_OUTCOMES[number] | 'all'
  changesFilter?: 'all' | 'removed' | 'promoted' | 'deleted'
  search?: string
  locale?: string
  limit?: number
  offset?: number
  anchor?: {kind:'path';value:string}|{kind:'group';id:number}
}
export interface ScanAuditViewPage {
  auditAvailable: boolean
  snapshot: ScanAuditSnapshotIdentity
  items: import('./scanAuditView').ViewItem[]
  total: number
  attentionBadgeCount: number
  limit: number
  offset: number
  anchorOffset: number | null
}
