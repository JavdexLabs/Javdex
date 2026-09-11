import type { PendingAuditIds } from '@shared/libraryTypes'
import { getDb } from './database'

/** Current audit page only. Scan IDs are library-scoped; scrape snapshots are global. */
export function getPendingAuditPresence(libraryId: number, input: PendingAuditIds): PendingAuditIds {
  const groups = [input.groupIds, input.identityIds, input.scrapeIds]
  if (!Number.isSafeInteger(libraryId) || libraryId < 1 || groups.reduce((n, ids) => n + ids.length, 0) > 100 ||
      groups.some(ids => ids.some(id => !Number.isSafeInteger(id) || id < 1))) throw new Error('Invalid audit pending IDs')
  const db = getDb()
  return db.transaction(() => {
    if (!db.prepare('SELECT id FROM media_libraries WHERE id = ?').get(libraryId)) throw new Error('媒体库不存在')
    const lookup = (table: 'pending_scan_groups' | 'pending_resource_identities' | 'pending_video_scrapes', ids: number[], scoped: boolean): number[] => {
      const unique = [...new Set(ids)]
      if (!unique.length) return []
      return (db.prepare(`SELECT id FROM ${table} WHERE ${scoped ? 'library_id = ? AND ' : ''}id IN (${unique.map(() => '?').join(',')}) ORDER BY id`)
        .all(...(scoped ? [libraryId, ...unique] : unique)) as Array<{id:number}>).map(row => row.id)
    }
    return {groupIds:lookup('pending_scan_groups',input.groupIds,true),
      identityIds:lookup('pending_resource_identities',input.identityIds,true),
      scrapeIds:lookup('pending_video_scrapes',input.scrapeIds,false)}
  })()
}
