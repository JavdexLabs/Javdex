import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from './database'
import { pagePendingScanQueue, countPendingScanQueue } from './pendingScanQueueRepo'
import { getPendingResourceIdentity } from './pendingResourceIdentityRepo'
it('pages10k scan decisions in legacy order, scopes active libraries and exposes no resource snapshots',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-scan-queue-'))
 try{
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.exec(`INSERT INTO media_libraries(id,name,position) VALUES(2,'First',-1),(3,'Archived',2);
   UPDATE media_libraries SET status='archived' WHERE id=3;
   INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/one','/one'),(2,2,'/two','/two'),(3,3,'/three','/three');
   WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
   INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) SELECT x,1,'G-'||x,'2026' FROM n;
   INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) VALUES(10001,2,'FIRST','2026'),(10002,3,'ARCHIVED','2026');
   INSERT INTO pending_scan_resources(library_id,group_id,root_id,file_path,normalized_path) VALUES(2,10001,2,'/two/file','/two/file');
   INSERT INTO pending_resource_identities(id,library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code,updated_at)
    VALUES(1,2,2,'/private/path/visible.mp4','/private/path/visible.mp4','local','FILE','NFO','2026'),(2,1,1,'/private/second.mp4','/private/second.mp4','local','SECOND','OTHER','2026');`)
  const first=pagePendingScanQueue({})
  assert.equal(first.total,10003);assert.equal(first.items.length,50)
  assert.deepEqual(first.items[0],{kind:'group',id:10001,libraryId:2,revision:1,label:'FIRST',resourceCount:1})
  assert.equal(first.items[1].id,1);assert.equal('resources' in first.items[0],false)
  assert.equal(countPendingScanQueue(3),0);assert.equal(countPendingScanQueue(2),2)
  const identity=pagePendingScanQueue({anchor:{kind:'identity',id:1}})
  assert.equal(identity.offset,10000)
  assert.deepEqual(identity.items.map(row=>row.kind),['group','identity','identity'])
  const row=identity.items[1]
  assert.deepEqual(row,{kind:'identity',id:1,libraryId:2,revision:1,label:'FILE ↔ NFO',displayName:'visible.mp4'})
  assert.ok(!JSON.stringify(identity).includes('/private'))
  assert.equal(getPendingResourceIdentity(1,1),null)
  assert.equal(getPendingResourceIdentity(2,1)!.displayName,'visible.mp4')
  const scoped=pagePendingScanQueue({libraryId:2,anchor:{kind:'group',id:1}})
  assert.equal(scoped.total,2);assert.ok(scoped.items.every(item=>item.libraryId===2))
  db.exec('DELETE FROM pending_scan_groups WHERE id<10000; DELETE FROM pending_resource_identities')
  assert.equal(pagePendingScanQueue({offset:10000}).offset,0)
  for(const query of [{limit:101},{offset:-1},{libraryId:0},{anchor:{kind:'group' as const,id:Number.MAX_SAFE_INTEGER+1}}])assert.throws(()=>pagePendingScanQueue(query),/Invalid/)
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
