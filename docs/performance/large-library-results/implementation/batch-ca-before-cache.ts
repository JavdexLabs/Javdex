import type Database from 'better-sqlite3'
import type {LibraryScanAudit,LibraryScanFileAuditEntry} from '@shared/libraryTypes'
import type {ScanAuditSnapshotIdentity,ScanAuditViewQuery,ScanAuditViewPage} from '@shared/scanAuditReadTypes'
import {SCAN_AUDIT_OUTCOMES} from '@shared/scanAuditReadTypes'
import {buildScanAuditViewItems,fileView} from '@shared/scanAuditView'

type Pointer={source:string;ordinal:number;display_index:number;entry_bytes:number}
/** Called inside the index construction transaction with TEMP writes allowed. */
export function prepareScanAuditViews(db:Database.Database,snapshot:ScanAuditSnapshotIdentity,pageBytes:number){
 db.exec(`CREATE INDEX temp.scan_audit_file_path ON scan_audit_entries(section,json_extract(entry,'$.filePath'));
  CREATE INDEX temp.scan_audit_video_id ON scan_audit_entries(section,json_extract(entry,'$.videoId'));
  CREATE TEMP TABLE scan_audit_unrecognized(path TEXT PRIMARY KEY,root_id INTEGER NOT NULL,ordinal INTEGER NOT NULL UNIQUE) WITHOUT ROWID;`)
 db.prepare(`INSERT INTO temp.scan_audit_unrecognized(path,root_id,ordinal)
  SELECT file_path,root_id,ROW_NUMBER() OVER(ORDER BY normalized_path)-1 FROM (
   SELECT file_path,root_id,normalized_path,ROW_NUMBER() OVER(PARTITION BY file_path ORDER BY normalized_path) AS duplicate
   FROM library_unrecognized_files WHERE library_id=?
  ) WHERE duplicate=1`).run(snapshot.libraryId)
 db.function('scan_audit_search_contains',{deterministic:true},(raw:unknown,needle:unknown,locale:unknown)=>{
  if(typeof raw!=='string'||typeof needle!=='string'||typeof locale!=='string')throw new Error('Invalid audit search')
  const item=fileView(JSON.parse(raw) as LibraryScanFileAuditEntry,0)
  return `${item.title} ${item.detail} ${item.path??''}`.toLocaleLowerCase(locale).includes(needle)?1:0
 })
 const attentionBadgeCount=(db.prepare(`SELECT
  (SELECT COUNT(*) FROM temp.scan_audit_entries WHERE section='files' AND attention=1)+
  (SELECT COUNT(*) FROM temp.scan_audit_entries WHERE section='pendingGroups')+
  (SELECT COUNT(*) FROM temp.scan_audit_unrecognized u WHERE NOT EXISTS(
   SELECT 1 FROM temp.scan_audit_entries e WHERE e.section='files' AND e.outcome='unrecognized' AND json_extract(e.entry,'$.filePath')=u.path
  )) AS n`).get() as {n:number}).n
 const empty:LibraryScanAudit={...snapshot,schemaVersion:2,configRevision:0,trigger:'manual',startedAt:'',status:'success',files:[],removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
 return (query:ScanAuditViewQuery):ScanAuditViewPage=>{
  if(!db.open)throw new Error('Audit index is closed')
  const {tab,outcome='all',changesFilter='all',limit=100,offset:requestedOffset=0,search='',anchor}=query
  if(!['failed','all','added_updated','skipped','changes'].includes(tab)
   ||(outcome!=='all'&&!SCAN_AUDIT_OUTCOMES.includes(outcome))||!['all','removed','promoted','deleted'].includes(changesFilter)
   ||typeof search!=='string'||search.length>500||!Number.isSafeInteger(limit)||limit<1||limit>100
   ||!Number.isSafeInteger(requestedOffset)||requestedOffset<0)throw new Error('Invalid audit view query')
  if(anchor&&(tab!=='failed'||(anchor.kind==='path'?(typeof anchor.value!=='string'||!anchor.value||anchor.value.length>32768):anchor.kind==='group'?(!Number.isSafeInteger(anchor.id)||anchor.id<=0):true)))throw new Error('Invalid audit anchor')
  const locale=query.locale===undefined?Intl.DateTimeFormat().resolvedOptions().locale:query.locale
  if(typeof locale!=='string'||locale.length>100||!locale)throw new Error('Invalid audit locale')
  Intl.getCanonicalLocales(locale)
  const needle=tab==='all'?search.trim().toLocaleLowerCase(locale):''
  const params:Array<string|number>=[]
  const select=(section:string,priority:number,where='1')=>`SELECT '${section}' AS source,ordinal,entry_bytes,${priority} AS priority FROM temp.scan_audit_entries WHERE section='${section}' AND ${where}`
  let candidates:string
  if(tab==='failed'){
   candidates=`SELECT 'extra' AS source,u.ordinal,length(CAST(u.path AS BLOB))+128 AS entry_bytes,0 AS priority
    FROM temp.scan_audit_unrecognized u WHERE NOT EXISTS(SELECT 1 FROM temp.scan_audit_entries e WHERE e.section='files' AND e.attention=1 AND json_extract(e.entry,'$.filePath')=u.path)
    UNION ALL ${select('files',1,'attention=1')} UNION ALL ${select('pendingGroups',2)}`
  }else if(tab==='changes'){
   const selected=changesFilter==='all'?['removedResources','promotedResources','deletedVideos']:changesFilter==='removed'?['removedResources']:changesFilter==='promoted'?['promotedResources']:['deletedVideos']
   candidates=selected.map((section,i)=>select(section,i)).join(' UNION ALL ')
  }else{
   const where=tab==='added_updated'?"outcome IN ('added','updated')":tab==='skipped'?"outcome='skipped'":outcome==='all'?'1':(params.push(outcome),'outcome=?')
   candidates=select('files',0,where)
  }
  // display_index is the legacy filtered-section map index, before search removes rows.
  const prefix=`WITH candidates AS (${candidates}), ranked AS (
   SELECT *,ROW_NUMBER() OVER(PARTITION BY source ORDER BY ordinal)-1 AS display_index FROM candidates
  ), matched AS (SELECT * FROM ranked ${needle?"WHERE scan_audit_search_contains((SELECT entry FROM temp.scan_audit_entries e WHERE e.section=ranked.source AND e.ordinal=ranked.ordinal),?,?)=1":''})`
  if(needle)params.push(needle,locale)
  const total=(db.prepare(`${prefix} SELECT COUNT(*) AS n FROM matched`).get(...params) as {n:number}).n
  let offset=Math.min(requestedOffset,Math.max(0,Math.floor((total-1)/limit)*limit)),anchorOffset:number|null=null
  if(anchor){
   const entry="(SELECT entry FROM temp.scan_audit_entries e WHERE e.section=positioned.source AND e.ordinal=positioned.ordinal)"
   const group=`CASE WHEN source='pendingGroups' OR (source='files' AND json_extract(${entry},'$.outcome')='pending') THEN json_extract(${entry},'$.groupId') END`
   const path=`CASE WHEN source='extra' THEN (SELECT path FROM temp.scan_audit_unrecognized u WHERE u.ordinal=positioned.ordinal) ELSE json_extract(${entry},'$.filePath') END`
   const predicate=anchor.kind==='group'?`${group}=?`:`COALESCE(${group},0)=0 AND ${path}=?`
   const row=db.prepare(`${prefix}, positioned AS (SELECT *,ROW_NUMBER() OVER(ORDER BY priority,ordinal)-1 AS position FROM matched)
    SELECT position FROM positioned WHERE ${predicate} ORDER BY position LIMIT 1`).get(...params,anchor.kind==='group'?anchor.id:anchor.value) as {position:number}|undefined
   if(row){anchorOffset=Math.floor(row.position/limit)*limit;offset=anchorOffset}
  }
  const pointers=db.prepare(`${prefix} SELECT source,ordinal,display_index,entry_bytes FROM matched ORDER BY priority,ordinal LIMIT ? OFFSET ?`).all(...params,limit,offset) as Pointer[]
  if(pointers.reduce((sum,row)=>sum+row.entry_bytes,0)>pageBytes)throw new Error('Audit view page exceeds byte budget')
  const items=pointers.map(pointer=>{
   let item
   if(pointer.source==='extra'){
    const row=db.prepare('SELECT path,root_id FROM temp.scan_audit_unrecognized WHERE ordinal=?').get(pointer.ordinal) as {path:string;root_id:number}
    item=buildScanAuditViewItems({audit:empty,unrecognized:[{filePath:row.path,rootId:row.root_id}],activeTab:'failed',outcome:'all',changesFilter:'all'})[0]
    item.key=`extra-unrec:${pointer.display_index}:${row.path}`
   }else{
    const entry=JSON.parse((db.prepare('SELECT entry FROM temp.scan_audit_entries WHERE section=? AND ordinal=?').get(pointer.source,pointer.ordinal) as {entry:string}).entry) as Record<string,unknown>
    const pending=pointer.source==='files'?db.prepare('SELECT path,root_id FROM temp.scan_audit_unrecognized WHERE path=?').get(String(entry.filePath)) as {path:string;root_id:number}|undefined:undefined
    const audit={...empty,[pointer.source]:[entry]} as LibraryScanAudit
    if(pointer.source==='removedResources'&&db.prepare("SELECT 1 FROM temp.scan_audit_entries WHERE section='deletedVideos' AND json_extract(entry,'$.videoId')=?").get(entry.videoId))audit.deletedVideos=[{videoId:Number(entry.videoId),videoCode:'',videoTitle:null,reason:'resource_less'}]
    item=buildScanAuditViewItems({audit,unrecognized:pending?[{filePath:pending.path,rootId:pending.root_id}]:[],activeTab:tab,outcome:'all',changesFilter:pointer.source==='removedResources'?'removed':pointer.source==='promotedResources'?'promoted':pointer.source==='deletedVideos'?'deleted':'all'})[0]
    if(pointer.source==='files')item.key=`file:${pointer.display_index}:${entry.filePath}`
    else if(pointer.source==='removedResources'||pointer.source==='promotedResources')item.key=`resource:${pointer.display_index}:${entry.resourceId}`
    else if(pointer.source==='deletedVideos')item.key=`deleted:${pointer.display_index}:${entry.videoId}`
   }
   return item
  })
  const result:ScanAuditViewPage={snapshot:{...snapshot},items,total,attentionBadgeCount,limit,offset,anchorOffset}
  if(Buffer.byteLength(JSON.stringify(result))>pageBytes)throw new Error('Audit view page exceeds byte budget')
  return result
 }
}
