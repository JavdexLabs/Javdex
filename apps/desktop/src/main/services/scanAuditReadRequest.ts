import { SCAN_AUDIT_SECTIONS, SCAN_AUDIT_OUTCOMES } from '@shared/scanAuditReadTypes'
import type { ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import type { ScanAuditIndexLimits, ScanAuditIndexQuery, ScanAuditSnapshotIdentity } from './scanAuditReadIndex'

/** Validate before worker allocation and copy only the supported scalar fields. */
export function normalizeScanAuditReadRequest(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditIndexQuery, limits: ScanAuditIndexLimits) {
  const base=normalizeAuditScope(snapshot,limits)
  const {section,outcome,attention,limit=100,offset=0} = query
  if (!SCAN_AUDIT_SECTIONS.includes(section)
    || (outcome !== undefined && !SCAN_AUDIT_OUTCOMES.includes(outcome))
    || (attention !== undefined && typeof attention !== 'boolean')
    || (section !== 'files' && (outcome !== undefined || attention !== undefined))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid audit page query')
  return {
    ...base, query: {section,outcome,attention,limit,offset}
  }
}

/** Preserve legacy locale-sensitive search while making queued input independent of callers. */
export function normalizeScanAuditViewQuery(query: ScanAuditViewQuery): ScanAuditViewQuery {
  const {tab,outcome='all',changesFilter='all',limit=100,offset=0,search='',anchor}=query
  if(!['failed','all','added_updated','skipped','changes'].includes(tab)
    ||(outcome!=='all'&&!SCAN_AUDIT_OUTCOMES.includes(outcome))||!['all','removed','promoted','deleted'].includes(changesFilter)
    ||typeof search!=='string'||search.length>500||!Number.isSafeInteger(limit)||limit<1||limit>100
    ||!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid audit view query')
  if(anchor&&(tab!=='failed'||(anchor.kind==='path'?(typeof anchor.value!=='string'||!anchor.value||anchor.value.length>32768):anchor.kind==='group'?(!Number.isSafeInteger(anchor.id)||anchor.id<=0):true)))throw new Error('Invalid audit anchor')
  const locale=query.locale===undefined?Intl.DateTimeFormat().resolvedOptions().locale:query.locale
  if(typeof locale!=='string'||locale.length>100||!locale)throw new Error('Invalid audit locale')
  Intl.getCanonicalLocales(locale)
  return {tab,outcome,changesFilter,limit,offset,search,locale,
    ...(anchor?{anchor:anchor.kind==='path'?{kind:'path' as const,value:anchor.value}:{kind:'group' as const,id:anchor.id}}:{})}
}
export function normalizeScanAuditViewRequest(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditViewQuery, limits: ScanAuditIndexLimits) {
  const base=normalizeAuditScope(snapshot,limits)
  return {...base,query:normalizeScanAuditViewQuery(query)}
}

function normalizeAuditScope(snapshot: ScanAuditSnapshotIdentity, limits: ScanAuditIndexLimits) {
  if (!Number.isSafeInteger(snapshot.libraryId) || snapshot.libraryId <= 0
    || typeof snapshot.runId !== 'string' || !snapshot.runId || snapshot.runId.length > 256
    || typeof snapshot.finishedAt !== 'string' || !snapshot.finishedAt || snapshot.finishedAt.length > 100) throw new Error('Invalid audit snapshot identity')
  for (const value of [limits.sourceBytes, limits.indexBytes, limits.pageBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid audit index budget')
  }
  return {
    snapshot: {libraryId:snapshot.libraryId,runId:snapshot.runId,finishedAt:snapshot.finishedAt},
    limits: {sourceBytes:limits.sourceBytes,indexBytes:limits.indexBytes,pageBytes:limits.pageBytes}
  }
}
