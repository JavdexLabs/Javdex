/** Synthetic, already-consistent actor queue; no user database/media access. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../apps/desktop/src/main/db/database'
import { ActressIdentityConflictWorkflow } from '../../apps/desktop/src/main/services/actressIdentityConflictWorkflow'
it('measures unchanged versus invalidated actor conflict maintenance',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-actor-maintenance-'))
 try{
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.transaction(()=>{
   db.exec(`CREATE TABLE maintenance_benchmark_probe(value INTEGER); INSERT INTO maintenance_benchmark_probe VALUES(0);
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
    INSERT INTO actresses(id,main_name) SELECT x,'Actor-'||x FROM n;
    INSERT INTO actress_names(actress_id,name,type,source) SELECT id,main_name,'main','manual' FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name(main_name),id FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name('Collision-'||id),10001 FROM actresses WHERE id<=10000;
    INSERT INTO actress_names(actress_id,name,type,source) SELECT 10001,'Collision-'||id,'alias','manual' FROM actresses WHERE id<=10000;`)
   const insert=db.prepare(`INSERT INTO pending_actress_scrapes(id,actress_id,target_actress_revision,plugin_name,plugin_source,query_name,selected_fields_json,applicable_fields_json,update_mode,result_json,warnings_json,created_at)
     VALUES(?,?,1,'Fixture','builtin',?,'["aliases"]','["aliases"]','replace',?,'[]','2026')`)
   for(let id=1;id<=10000;id++)insert.run(id,id,`Actor-${id}`,JSON.stringify({aliases:[`Collision-${id}`],summary:'x'.repeat(4096)}))
   db.exec(`INSERT INTO pending_actress_scrape_conflicts(pending_scrape_id,normalized_name,name,name_type)
     SELECT id,normalize_actress_name('Collision-'||id),'Collision-'||id,'alias' FROM pending_actress_scrapes`)
  })()
  db.exec('ANALYZE')
  const workflow=new ActressIdentityConflictWorkflow()
  const expected={groupCount:10000,conflictGroupCount:10000,applicableGroupCount:0,pendingScrapeCount:10000,pendingNameClaimGroupCount:0}
  const results:Array<{name:string;samples:number[];medianMs:number;jsonBytes:number}>=[]
  function measure(name:string,invalidate:boolean){
   const samples:number[]=[];let jsonBytes=0
   for(let i=0;i<3;i++){
    if(invalidate)db.exec('UPDATE maintenance_benchmark_probe SET value=value+1')
    const start=performance.now();const value=workflow.getConflictReviewSummary();samples.push(performance.now()-start)
    assert.deepEqual(value,expected);jsonBytes=Buffer.byteLength(JSON.stringify(value))
   }
   results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
  }
  measure('invalidated.full-check',true)
  measure('unchanged.skip-check',false)
  measure('invalidated.again',true)
  const result={pending:10000,resultSummaryCharacters:4096,results,platform:process.platform,arch:process.arch,
   sqliteVersion:db.prepare('SELECT sqlite_version() AS version').get(),caveats:['Three sequential warm samples per stage after ANALYZE; not p95/cold/Windows/HDD/full IPC.','Invalidation is a real write to an unrelated probe table before timing; actor business rows unchanged. This compares miss/hit paths in the same implementation, not an old-build benchmark.','Output equality checks all summary fields. Consistent fixture requires no repairs; repair-heavy workloads still rescan until a no-write pass.','Group/status aggregation still scans the conflict relation on every call; only redundant consistency maintenance is skipped. No DTO or JSON result cache.']}
  if(process.env.JAVDEX_ACTRESS_MAINTENANCE_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_ACTRESS_MAINTENANCE_OUTPUT),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
