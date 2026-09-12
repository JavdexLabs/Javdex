import type { PendingScanQueuePage, PendingScanQueueQuery, PendingScanQueueItem } from '@shared/libraryTypes'
import { localPathBasename } from '@library/localPathIdentity'
import { getDb } from './database'

const queueSql = `WITH queue AS (
  SELECT 0 AS kind,id,library_id,updated_at FROM pending_scan_groups
  UNION ALL SELECT 1,id,library_id,updated_at FROM pending_resource_identities
), eligible AS (
  SELECT queue.*,library.position FROM queue JOIN media_libraries library ON library.id=queue.library_id
  WHERE library.status='active' AND (? IS NULL OR library.id=?)
)`
function libraryScope(libraryId?: number): number | null {
  if (libraryId !== undefined && (!Number.isSafeInteger(libraryId) || libraryId < 1)) throw new Error('Invalid scan queue library')
  return libraryId ?? null
}
export function countPendingScanQueue(libraryId?: number): number {
  const scope=libraryScope(libraryId)
  return (getDb().prepare(`${queueSql} SELECT COUNT(*) AS n FROM eligible`).get(scope,scope) as {n:number}).n
}
function caption(value:string):string {
  const chars=Array.from(value)
  return chars.length>128 ? chars.slice(0,128).join('')+'…' : value
}

/** Group-first and library-position order preserves the existing combined inbox ordering. */
export function pagePendingScanQueue(query:PendingScanQueueQuery):PendingScanQueuePage {
  const scope=libraryScope(query.libraryId)
  const {limit=50,offset=0,anchor}=query
  if (!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||
      (anchor && (!['group','identity'].includes(anchor.kind)||!Number.isSafeInteger(anchor.id)||anchor.id<1))) throw new Error('Invalid scan queue page')
  const db=getDb()
  return db.transaction(()=>{
    const total=countPendingScanQueue(query.libraryId)
    let pageOffset=Math.min(offset,Math.max(0,Math.floor((total-1)/limit)*limit))
    if(anchor){
      const target=db.prepare(`${queueSql} SELECT kind,position,library_id,updated_at,id FROM eligible WHERE kind=? AND id=?`)
        .get(scope,scope,anchor.kind==='group'?0:1,anchor.id) as {kind:number;position:number;library_id:number;updated_at:string;id:number}|undefined
      if(target){
        const before=db.prepare(`${queueSql} SELECT COUNT(*) AS n FROM eligible WHERE (kind,position,library_id,updated_at,id)<(?,?,?,?,?)`)
          .get(scope,scope,target.kind,target.position,target.library_id,target.updated_at,target.id) as {n:number}
        pageOffset=Math.floor(before.n/limit)*limit
      }
    }
    const rows=db.prepare(`${queueSql} SELECT kind,id,library_id FROM eligible ORDER BY kind,position,library_id,updated_at,id LIMIT ? OFFSET ?`)
      .all(scope,scope,limit,pageOffset) as Array<{kind:number;id:number;library_id:number}>
    const group=db.prepare(`SELECT revision,substr(normalized_code,1,129) AS code,
      (SELECT COUNT(*) FROM pending_scan_resources WHERE library_id=g.library_id AND group_id=g.id) AS resourceCount
      FROM pending_scan_groups g WHERE library_id=? AND id=?`)
    const identity=db.prepare(`SELECT revision,substr(filename_code,1,129) AS filenameCode,substr(nfo_code,1,129) AS nfoCode,
      substr(file_path,-4096) AS pathTail FROM pending_resource_identities WHERE library_id=? AND id=?`)
    const items:PendingScanQueueItem[]=rows.map(row=>{
      if(row.kind===0){
        const value=group.get(row.library_id,row.id) as {revision:number;code:string;resourceCount:number}
        return {kind:'group',id:row.id,libraryId:row.library_id,revision:value.revision,label:caption(value.code),resourceCount:value.resourceCount}
      }
      const value=identity.get(row.library_id,row.id) as {revision:number;filenameCode:string;nfoCode:string;pathTail:string}
      return {kind:'identity',id:row.id,libraryId:row.library_id,revision:value.revision,
        label:`${caption(value.filenameCode)} ↔ ${caption(value.nfoCode)}`,displayName:caption(localPathBasename(value.pathTail))}
    })
    return {items,total,offset:pageOffset}
  })()
}
