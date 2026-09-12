/** Synthetic, already-consistent actor queue; no user database/media access. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../apps/desktop/src/main/db/database'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'
import { ActressIdentityConflictWorkflow } from '../../apps/desktop/src/main/services/actressIdentityConflictWorkflow'
it('measures actor queue metadata and selected details',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-actor-queue-'))
 const previousUserData=process.env.JAVDEX_TEST_USER_DATA
 process.env.JAVDEX_TEST_USER_DATA=root
 resetSettingsCacheForTests()
 try{
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.transaction(()=>{
   db.exec(`CREATE TABLE maintenance_benchmark_probe(value INTEGER); INSERT INTO maintenance_benchmark_probe VALUES(0);
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001)
    INSERT INTO actresses(id,main_name) SELECT x,'Actor-'||x FROM n;
    INSERT INTO actress_names(actress_id,name,type,source) SELECT id,main_name,'main','manual' FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name(main_name),id FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name('Collision-'||id),1001 FROM actresses WHERE id<=1000;
    INSERT INTO actress_names(actress_id,name,type,source) SELECT 1001,'Collision-'||id,'alias','manual' FROM actresses WHERE id<=1000;`)
   const insert=db.prepare(`INSERT INTO pending_actress_scrapes(id,actress_id,target_actress_revision,plugin_name,plugin_source,query_name,selected_fields_json,applicable_fields_json,update_mode,result_json,warnings_json,created_at)
     VALUES(?,?,1,'Fixture','builtin',?,'["aliases"]','["aliases"]','replace',?,'[]','2026')`)
   for(let id=1;id<=1000;id++)insert.run(id,id,`Actor-${id}`,JSON.stringify({aliases:[`Collision-${id}`],summary:'x'.repeat(4096)}))
   db.exec(`INSERT INTO pending_actress_scrape_conflicts(pending_scrape_id,normalized_name,name,name_type)
     SELECT id,normalize_actress_name('Collision-'||id),'Collision-'||id,'alias' FROM pending_actress_scrapes`)
  })()
  db.exec('ANALYZE')
  const workflow=new ActressIdentityConflictWorkflow()
  workflow.getConflictReviewSummary()
  const results:Array<{name:string;samples:number[];medianMs:number;jsonBytes:number}>=[]
  function measure(name:string,read:()=>unknown,check:(value:unknown)=>void){
    const samples:number[]=[];let jsonBytes=0
    for(let i=0;i<3;i++){
      const start=performance.now();const value=read();samples.push(performance.now()-start)
      check(value);jsonBytes=Buffer.byteLength(JSON.stringify(value))
    }
    results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
  }
  const oracle=workflow.listConflictGroups(false)
  const summaries=oracle.map(group=>({normalizedName:group.normalizedName,displayName:group.displayName,
    status:group.status,candidateCount:group.candidates.length,pendingNameClaimCount:group.pendingNameClaims.length,
    avatarPath:group.candidates[0]?.actressAvatarPath??null}))
  measure('full.without-field-previews',()=>workflow.listConflictGroups(false),value=>assert.deepEqual(value,oracle))
  measure('summary.first50',()=>workflow.pageConflictQueue({}),value=>assert.deepEqual(value,{items:summaries.slice(0,50),total:1000,offset:0}))
  const selected=oracle[876]
  measure('summary.anchor876',()=>workflow.pageConflictQueue({anchorName:selected.normalizedName}),value=>assert.deepEqual(value,{items:summaries.slice(850,900),total:1000,offset:850}))
  const selectedOracle=workflow.listConflictGroups().find(group=>group.normalizedName===selected.normalizedName)
  assert.ok(selectedOracle)
  measure('detail.selected',()=>workflow.getConflictGroup(selected.normalizedName),value=>assert.deepEqual(value,selectedOracle))
  const result={pending:1000,resultSummaryCharacters:4096,results,platform:process.platform,arch:process.arch,
   sqliteVersion:db.prepare('SELECT sqlite_version() AS version').get(),caveats:['1000 consistent pending groups with4KiB result text, after ANALYZE; three warm samples per stage, not p95/cold/Windows/HDD/full IPC.',
    'Full comparator disables field previews but still includes candidates, resources, claimants and pair preflight; it understates default full UI read cost.',
    'Summary first/deep pages equal old projection in complete order. Selected detail equals its group from the default full legacy API, including field previews and merge pairs.',
    'Metadata grouping/sorting remains global and maintenance is warmed first. A single selected group and its merge pairs remain unbounded.',
    'Oracle objects stay alive throughout; no independent heap or peak RSS claim. Timings exclude assertions and serialization.']}

  if(process.env.JAVDEX_ACTRESS_QUEUE_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_ACTRESS_QUEUE_OUTPUT),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
 }finally{closeDatabase();resetSettingsCacheForTests();if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previousUserData;fs.rmSync(root,{recursive:true,force:true})}
})
