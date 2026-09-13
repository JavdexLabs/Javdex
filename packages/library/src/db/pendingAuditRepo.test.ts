import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from './database'
import { getPendingAuditPresence } from './pendingAuditRepo'

it('scopes scan identities and groups while returning only requested IDs from a large catalog',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-pending-audit-'))
 try{
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.exec(`INSERT INTO media_libraries(id,name) VALUES(2,'Other');
    INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/one','/one'),(2,2,'/two','/two');
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO pending_scan_groups(id,library_id,normalized_code) SELECT x,CASE WHEN x%2=0 THEN 2 ELSE 1 END,'G-'||x FROM n;
    INSERT INTO pending_resource_identities(id,library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code)
      SELECT id,library_id,library_id,'/path/'||id,'/path/'||id,'local','F-'||id,'N-'||id FROM pending_scan_groups;
    INSERT INTO videos(id,code) VALUES(1,'VIDEO');
    INSERT INTO pending_video_scrapes(id,video_id,selected_fields_json,applicable_fields_json,update_mode,request_json,warnings_json,created_at,updated_at)
    VALUES(1,1,'bad-json','bad-json','replace','bad-json','bad-json','2026','2026');`)
  const input={groupIds:[1,2,9999,10001,1],identityIds:[1,2,10000,10001],scrapeIds:[1,2]}
  assert.deepEqual(getPendingAuditPresence(1,input),{groupIds:[1,9999],identityIds:[1],scrapeIds:[1]})
  assert.deepEqual(getPendingAuditPresence(2,input),{groupIds:[2],identityIds:[2,10000],scrapeIds:[1]})
  const trace:string[]=[];const prepare=db.prepare.bind(db)
  db.prepare=((sql:string)=>{trace.push(sql);return prepare(sql)}) as typeof db.prepare
  getPendingAuditPresence(1,input)
  assert.equal(trace.length,4);assert.ok(trace.every(sql=>sql.startsWith('SELECT id FROM')))
  assert.ok(trace.every(sql=>!sql.includes('pending_scan_resources')))
  db.exec('DELETE FROM pending_scan_groups WHERE id=1; DELETE FROM pending_resource_identities WHERE id=1; DELETE FROM pending_video_scrapes')
  assert.deepEqual(getPendingAuditPresence(1,input),{groupIds:[9999],identityIds:[],scrapeIds:[]})
  assert.throws(()=>getPendingAuditPresence(3,input),/不存在/)
  assert.throws(()=>getPendingAuditPresence(1,{groupIds:Array(51).fill(1),identityIds:Array(50).fill(1),scrapeIds:[]}),/Invalid/)
  assert.throws(()=>getPendingAuditPresence(1,{groupIds:[Number.MAX_SAFE_INTEGER+1],identityIds:[],scrapeIds:[]}),/Invalid/)
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
