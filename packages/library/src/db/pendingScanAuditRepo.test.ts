import {beforeEach,afterEach,it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import {initDatabaseAtPath,closeDatabase,getDb} from './database'
import {createMediaLibrary} from './mediaLibraryRepo'
import {listPendingScanGroups} from './pendingScanRepo'
import {readPendingScanAuditEntries} from './pendingScanAuditRepo'
let root:string,filename:string,libraryId:number,otherLibraryId:number,paths:Set<string>
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-pending-audit-'));filename=path.join(root,'db.sqlite');const db=initDatabaseAtPath(filename)
 const media=path.join(root,'media'),other=path.join(root,'other');fs.mkdirSync(media);fs.mkdirSync(other)
 const lib=createMediaLibrary({name:'Audit',roots:[{path:media}]}),otherLib=createMediaLibrary({name:'Other',roots:[{path:other}]});libraryId=lib.id;otherLibraryId=otherLib.id
 const group=db.prepare('INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) VALUES(?,?,?,?)')
 const resource=db.prepare('INSERT INTO pending_scan_resources(library_id,group_id,root_id,file_path,normalized_path,target_kind,target_locator,display_name) VALUES(?,?,?,?,?,?,?,?)')
 db.transaction(()=>{
  for(let i=1;i<=25;i++){
   group.run(i,libraryId,`CODE-${i}`,i%2?'b':'a')
   for(let j=0;j<5;j++){const filePath=path.join(media,`${i}-${j}.mp4`);resource.run(libraryId,i,lib.roots[0].id,filePath,`${i}-${j}`,'web','https://example.invalid/'+ 'x'.repeat(4096),'y'.repeat(4096))}
  }
  group.run(30,libraryId,'EMPTY','a');group.run(50,otherLibraryId,'OTHER','0')
  resource.run(otherLibraryId,50,otherLib.roots[0].id,path.join(other,'file.mp4'),'other','web','https://example.invalid','other')
  resource.run(libraryId,2,lib.roots[0].id,path.join(media,'1-0.mp4'),'duplicate-display-path','web','https://example.invalid','duplicate')
 })()
 paths=new Set([path.join(media,'1-0.mp4'),path.join(media,'2-1.mp4'),path.join(media,'25-4.mp4'),path.join(media,'CASE.mp4')])
})
afterEach(()=>{closeDatabase();fs.rmSync(root,{recursive:true,force:true})})
function oracle(ids:ReadonlySet<number>){return listPendingScanGroups(libraryId).filter(group=>ids.has(group.id)).map(group=>({groupId:group.id,normalizedCode:group.normalizedCode,resourceCount:group.resources.filter(resource=>paths.has(resource.filePath)).length}))}
it('matches old group order and global exact path counts without hydrating unrelated groups or resource DTOs',()=>{
 const ids=new Set([25,50,2,30,1,999]),expected=oracle(ids),db=getDb(),prepare=db.prepare.bind(db),statements:string[]=[],visited:number[]=[]
 db.prepare=((sql:string)=>{
  statements.push(sql);const statement=prepare(sql)
  if(sql.startsWith('SELECT file_path FROM pending_scan_resources')){
   const iterate=statement.iterate.bind(statement)
   statement.iterate=((...args:unknown[])=>{visited.push(Number(args[1]));return iterate(...args)}) as typeof statement.iterate
  }
  return statement
 }) as typeof db.prepare
 try{
  assert.deepEqual(readPendingScanAuditEntries(libraryId,ids,paths),expected)
  assert.deepEqual(expected.map(item=>item.groupId),[2,30,1,25]);assert.equal(expected[0].resourceCount,2)
  assert.deepEqual(visited,[2,30,1,25])
  for(const sql of statements)assert.doesNotMatch(sql,/SELECT \*|target_locator|display_name|size_bytes/i)
 }finally{db.prepare=prepare}
})
it('handles empty targets and empty paths while preserving zero-resource groups and library isolation',()=>{
 assert.deepEqual(readPendingScanAuditEntries(libraryId,new Set(),paths),[])
 assert.deepEqual(readPendingScanAuditEntries(libraryId,new Set([50]),paths),[])
 assert.deepEqual(readPendingScanAuditEntries(libraryId,new Set([30,2]),new Set()),[{groupId:2,normalizedCode:'CODE-2',resourceCount:0},{groupId:30,normalizedCode:'EMPTY',resourceCount:0}])
 assert.throws(()=>readPendingScanAuditEntries(0,new Set(),paths),/Invalid/)
 assert.throws(()=>readPendingScanAuditEntries(999,new Set(),paths),/不存在/)
})
it('keeps selected group metadata and path counts in one snapshot across an external write',()=>{
 const ids=new Set([1,2,25]),expected=oracle(ids),other=new Database(filename),has=paths.has.bind(paths);let changed=false
 paths.has=(value:string)=>{if(!changed){changed=true;other.transaction(()=>{other.prepare('DELETE FROM pending_scan_resources WHERE library_id=?').run(libraryId);other.prepare("UPDATE pending_scan_groups SET normalized_code='CHANGED-'||id,updated_at='0' WHERE library_id=?").run(libraryId)})()}return has(value)}
 try{assert.deepEqual(readPendingScanAuditEntries(libraryId,ids,paths),expected);assert.equal(changed,true);assert.notDeepEqual(readPendingScanAuditEntries(libraryId,ids,paths),expected)}finally{other.close();paths.has=has}
})
it('drives selected groups by primary key and resources by the scoped group index',()=>{
 const db=getDb()
 const groups=db.prepare(`EXPLAIN QUERY PLAN SELECT g.id,g.normalized_code FROM json_each(?) selected CROSS JOIN pending_scan_groups g ON g.id=selected.value WHERE g.library_id=? ORDER BY g.updated_at,g.id`).all('[1,2]',libraryId) as {detail:string}[]
 assert.ok(groups.some(row=>/SEARCH g USING INTEGER PRIMARY KEY/.test(row.detail)),JSON.stringify(groups))
 const resources=db.prepare('EXPLAIN QUERY PLAN SELECT file_path FROM pending_scan_resources WHERE library_id=? AND group_id=?').all(libraryId,1) as {detail:string}[]
 assert.ok(resources.some(row=>/idx_pending_scan_resources_group/.test(row.detail)),JSON.stringify(resources))
})

it('releases the transaction and connection when resource statement preparation fails', () => {
 const db = getDb(), prepare = db.prepare.bind(db)
 db.prepare = ((sql: string) => {
  if (sql.startsWith('SELECT file_path FROM pending_scan_resources')) throw new Error('injected prepare failure')
  return prepare(sql)
 }) as typeof db.prepare
 try {
  assert.throws(() => readPendingScanAuditEntries(libraryId, new Set([1]), paths), /injected prepare failure/)
 } finally { db.prepare = prepare }
 assert.equal(db.inTransaction, false)
 db.transaction(() => { db.prepare("UPDATE pending_scan_groups SET normalized_code='RECOVERED' WHERE id=1").run() })()
 assert.equal((db.prepare('SELECT normalized_code FROM pending_scan_groups WHERE id=1').get() as {normalized_code:string}).normalized_code, 'RECOVERED')
 db.pragma('journal_mode = DELETE')
})
