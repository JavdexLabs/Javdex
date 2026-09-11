/** Synthetic queue fixture. No user files/database. Repo time excludes JSON sizing/assertions. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../src/main/db/database'
import { listPendingScanGroups, getPendingScanGroup } from '../../src/main/db/pendingScanRepo'
import { listPendingResourceIdentities } from '../../src/main/db/pendingResourceIdentityRepo'
import { pagePendingScanQueue, countPendingScanQueue } from '../../src/main/db/pendingScanQueueRepo'
it('measures mixed scan summary pages against complete hydration',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-scan-bench-'))
 try{
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.transaction(()=>{
   db.exec(`INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/synthetic','/synthetic');
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO pending_scan_groups(id,library_id,normalized_code,updated_at) SELECT x,1,'GROUP-'||x,'2026' FROM n;
    INSERT INTO pending_resource_identities(id,library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code,updated_at)
     SELECT id,1,1,'/synthetic/'||id||'.mp4','/synthetic/'||id||'.mp4','local','FILE-'||id,'NFO-'||id,'2026' FROM pending_scan_groups;`)
   const insert=db.prepare('INSERT INTO pending_scan_resources(library_id,group_id,root_id,file_path,normalized_path,display_name) VALUES(1,?,1,?,?,?)')
   for(let id=1;id<=10000;id++)for(let j=0;j<2;j++)insert.run(id,`/synthetic/${id}-${j}.mp4`,`/synthetic/${id}-${j}.mp4`,'x'.repeat(4096))
  })()
  db.exec('ANALYZE')
  const results:Array<{name:string;samples:number[];medianMs:number;jsonBytes:number}>=[]
  function measure(name:string,read:()=>unknown,verify:(value:unknown)=>void){
   const samples:number[]=[];let jsonBytes=0
   for(let i=0;i<3;i++){const start=performance.now();const value=read();samples.push(performance.now()-start);verify(value);jsonBytes=Buffer.byteLength(JSON.stringify(value))}
   results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
  }
  measure('full',()=>({groups:listPendingScanGroups(1),identities:listPendingResourceIdentities(1)}),value=>{
   const rows=value as {groups:ReturnType<typeof listPendingScanGroups>;identities:ReturnType<typeof listPendingResourceIdentities>}
   assert.equal(rows.groups.length,10000);assert.equal(rows.identities.length,10000);assert.equal(rows.groups[9999].resources[1].displayName!.length,4096)
  })
  measure('summary.first',()=>pagePendingScanQueue({}),value=>assert.deepEqual(value,{total:20000,offset:0,items:Array.from({length:50},(_,i)=>({kind:'group',id:i+1,libraryId:1,revision:1,label:`GROUP-${i+1}`,resourceCount:2}))}))
  measure('summary.identity.deep',()=>pagePendingScanQueue({anchor:{kind:'identity',id:9876}}),value=>assert.deepEqual(value,{total:20000,offset:19850,items:Array.from({length:50},(_,i)=>({kind:'identity',id:9851+i,libraryId:1,revision:1,label:`FILE-${9851+i} ↔ NFO-${9851+i}`,displayName:`${9851+i}.mp4`}))}))
  measure('count',()=>countPendingScanQueue(),value=>assert.equal(value,20000))
  measure('detail.selected',()=>getPendingScanGroup(1,9876),value=>{const row=value as NonNullable<ReturnType<typeof getPendingScanGroup>>;assert.equal(row.id,9876);assert.equal(row.resources.length,2)})
  const result={groups:10000,identities:10000,resourcesPerGroup:2,resourceDisplayNameCharacters:4096,results,platform:process.platform,arch:process.arch,
   sqliteVersion:db.prepare('SELECT sqlite_version() AS version').get(),caveats:['Three sequential warm synthetic samples after ANALYZE; not p95, cold Windows/HDD or full IPC.','Repo time excludes assertions and JSON serialization. JSON bytes approximate transport payload.','Count, UNION ordering, OFFSET and anchor rank still scale with queue size; queries remain on main thread.','Selected group resources remain unbounded; this fixture has only two per group. Full hydration is measured first.']}
  if(process.env.JAVDEX_SCAN_BENCH_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_SCAN_BENCH_OUTPUT),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
