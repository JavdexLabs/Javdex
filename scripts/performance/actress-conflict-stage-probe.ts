/** Synthetic, already-consistent actor queue; no user database/media access. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../packages/library/src/db/database'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'
import { ActressIdentityConflictWorkflow } from '../../apps/desktop/src/main/services/actressIdentityConflictWorkflow'
it('locates skewed actor conflict costs by stage',()=>{
 const count=Number(process.env.JAVDEX_ACTRESS_PROBE_COUNT??1000)
 assert.ok(Number.isSafeInteger(count)&&count>=100&&count<=10000)
 const records:Array<{stage:string;ms:number}>=[]
 function stage<T>(name:string,run:()=>T):T {
  console.log('[stage:start]',name);const start=performance.now();const result=run();
  const row={stage:name,ms:performance.now()-start};records.push(row);console.log('[stage:end]',JSON.stringify(row));return result
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-actor-queue-'))
 const previousUserData=process.env.JAVDEX_TEST_USER_DATA
 process.env.JAVDEX_TEST_USER_DATA=root
 resetSettingsCacheForTests()
 try{
  const db=stage('database.init',()=>initDatabaseAtPath(path.join(root,'catalog.db')))
  stage('fixture',()=>db.transaction(()=>{
   db.exec(`CREATE TABLE maintenance_benchmark_probe(value INTEGER); INSERT INTO maintenance_benchmark_probe VALUES(0);
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count+1})
    INSERT INTO actresses(id,main_name) SELECT x,'Actor-'||x FROM n;
    INSERT INTO actress_names(actress_id,name,type,source) SELECT id,main_name,'main','manual' FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name(main_name),id FROM actresses;
    INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name('Collision-'||id),${count+1} FROM actresses WHERE id<=${count};
    INSERT INTO actress_names(actress_id,name,type,source) SELECT ${count+1},'Collision-'||id,'alias','manual' FROM actresses WHERE id<=${count};`)
   const insert=db.prepare(`INSERT INTO pending_actress_scrapes(id,actress_id,target_actress_revision,plugin_name,plugin_source,query_name,selected_fields_json,applicable_fields_json,update_mode,result_json,warnings_json,created_at)
     VALUES(?,?,1,'Fixture','builtin',?,'["aliases"]','["aliases"]','replace',?,'[]','2026')`)
   for(let id=1;id<=count;id++)insert.run(id,id,`Actor-${id}`,JSON.stringify({aliases:[`Collision-${id}`],summary:'x'.repeat(4096)}))
   db.exec(`INSERT INTO pending_actress_scrape_conflicts(pending_scrape_id,normalized_name,name,name_type)
     SELECT id,normalize_actress_name('Collision-'||id),'Collision-'||id,'alias' FROM pending_actress_scrapes`)
  })())
  stage('analyze',()=>db.exec('ANALYZE'))
  const workflow=new ActressIdentityConflictWorkflow()
  stage('maintenance.cold',()=>workflow.getConflictReviewSummary())
  stage('maintenance.warm',()=>workflow.getConflictReviewSummary())
  const first=stage('page.first',()=>workflow.pageConflictQueue({}))
  assert.equal(first.total,count);assert.equal(first.items.length,50)
  const selected=first.items[25].normalizedName
  const detail=stage('detail.selected',()=>workflow.getConflictGroup(selected))
  assert.equal(detail?.normalizedName,selected)
  // Compare the same public get against the pre-AT SQL, only in this synthetic probe.
  let legacySqlReplacements = 0
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    if (!sql.includes('WITH merged_names AS MATERIALIZED')) return prepare(sql)
    legacySqlReplacements++
    const statement = prepare(`SELECT DISTINCT c.pending_scrape_id, c.normalized_name, c.name, p.actress_id
      FROM pending_actress_scrape_conflicts c JOIN pending_actress_scrapes p ON p.id = c.pending_scrape_id
      WHERE c.pending_scrape_id != ? AND p.actress_id NOT IN (?, ?)
        AND EXISTS (SELECT 1 FROM actress_names an WHERE an.actress_id IN (?, ?)
          AND normalize_actress_name(an.name) = c.normalized_name)
      ORDER BY c.normalized_name, c.pending_scrape_id`)
    const all = statement.all.bind(statement)
    statement.all = ((...args: number[]) => {
      assert.equal(args.length, 5)
      return all(args[2], args[3], args[4], args[0], args[1])
    }) as typeof statement.all
    return statement
  }) as typeof db.prepare
  try {
    const oldDetail = stage('detail.selected.legacy-sql', () => workflow.getConflictGroup(selected))
    assert.ok(legacySqlReplacements > 0, 'Legacy SQL replay must intercept the real merge preflight')
    assert.deepEqual(oldDetail, detail)
  } finally { db.prepare = prepare }
  if(process.env.JAVDEX_ACTRESS_PROBE_LEGACY!=='0') {
   const legacy=stage('legacy.no-field-plans',()=>workflow.listConflictGroups(false))
   assert.equal(legacy.length,count)
   const full=stage('legacy.full',()=>workflow.listConflictGroups())
   assert.deepEqual(full.find(group=>group.normalizedName===selected),detail)
  }
  const report={count,records,legacySqlReplacements,platform:process.platform,arch:process.arch,notes:['Single stage sample, synthetic shared owner with count aliases, 4KiB result JSON; not p95 or user-data benchmark.']}
  if(process.env.JAVDEX_ACTRESS_PROBE_OUTPUT)fs.writeFileSync(process.env.JAVDEX_ACTRESS_PROBE_OUTPUT,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report))
 }finally{closeDatabase();resetSettingsCacheForTests();if(previousUserData===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previousUserData;fs.rmSync(root,{recursive:true,force:true})}
})
