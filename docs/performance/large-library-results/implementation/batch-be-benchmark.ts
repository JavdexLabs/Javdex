/** Synthetic snapshot trade-off probe. No user data/media. Run without concurrent builds/tests. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase } from '../../apps/desktop/src/main/db/database'
import { listActressAvatarCropTargets } from '../../apps/desktop/src/main/db/actressRepo'
import { createActressAvatarCropSnapshot } from '../../apps/desktop/src/main/db/actressAvatarCropSnapshot'
import { resetSettingsCacheForTests } from '../../apps/desktop/src/main/settings/settingsStore'

it('measures full targets versus snapshot startup and page reads at two actor scales', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-avatar-snapshot-probe-'))
 const previous=process.env.JAVDEX_TEST_USER_DATA
 process.env.JAVDEX_TEST_USER_DATA=root;resetSettingsCacheForTests()
 const results:unknown[]=[]
 try {
  for(const count of [10000,100000]) {
   const db=initDatabaseAtPath(path.join(root,`scale-${count}.db`))
   db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO actresses(id,main_name,avatar_path,profile_summary)
    SELECT x,printf('Actor-%06d',x),'avatar.jpg',hex(zeroblob(2048)) FROM n; ANALYZE;`)
   const metrics:unknown[]=[]
   function summarize(name:string,samples:number[],jsonBytes:number) {
    const ordered=[...samples].sort((a,b)=>a-b)
    metrics.push({name,samples,medianMs:(ordered[9]+ordered[10])/2,p95NearestRankMs:ordered[18],jsonBytes})
   }
   const fullCheck=(rows:ReturnType<typeof listActressAvatarCropTargets>)=>{
    assert.equal(rows.length,count)
    for(let i=0;i<count;i++){assert.equal(rows[i].actressId,i+1);assert.equal(rows[i].mainName,`Actor-${String(i+1).padStart(6,'0')}`)}
   }
   fullCheck(listActressAvatarCropTargets())
   let samples:number[]=[],bytes=0
   for(let i=0;i<20;i++){const start=performance.now(),rows=listActressAvatarCropTargets();samples.push(performance.now()-start);fullCheck(rows);bytes=Buffer.byteLength(JSON.stringify(rows))}
   summarize('full-targets',samples,bytes)
   let warm=createActressAvatarCropSnapshot();warm.page(0);warm.dispose()
   samples=[]
   for(let i=0;i<20;i++){
    const start=performance.now(),snapshot=createActressAvatarCropSnapshot(),first=snapshot.page(0)
    samples.push(performance.now()-start)
    try{assert.equal(first.total,count);assert.equal(first.items.length,100);assert.equal(first.nextAfterId,100);bytes=Buffer.byteLength(JSON.stringify(first))}finally{snapshot.dispose()}
   }
   summarize('snapshot.create+first',samples,bytes)
   const snapshot=createActressAvatarCropSnapshot()
   let tempInfo:unknown,plan:unknown
   try {
    const table=(db.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name LIKE 'avatar_crop_%'").get() as {name:string}).name
    plan=db.prepare(`EXPLAIN QUERY PLAN SELECT actress_id,name_prefix FROM ${table} WHERE actress_id > ? ORDER BY actress_id ASC LIMIT 101`).all(count-100)
    assert.match(JSON.stringify(plan),/SEARCH.*INTEGER PRIMARY KEY/)
    tempInfo={compileOptions:db.pragma('compile_options').filter(row=>JSON.stringify(row).includes('TEMP_STORE')),tempStore:db.pragma('temp_store',{simple:true}),pageSize:db.pragma('temp.page_size',{simple:true}),pageCount:db.pragma('temp.page_count',{simple:true}),freelistCount:db.pragma('temp.freelist_count',{simple:true})}
    for(const [name,after] of [['page.first',0],['page.last',count-100]] as const){
     snapshot.page(after);samples=[]
     for(let i=0;i<20;i++){const start=performance.now(),page=snapshot.page(after);samples.push(performance.now()-start);assert.equal(page.items[0].actressId,after+1);assert.equal(page.items.length,100);bytes=Buffer.byteLength(JSON.stringify(page))}
     summarize(name,samples,bytes)
    }
    let cursor:number|null=0,expectedId=1
    while(cursor!==null){const page=snapshot.page(cursor);for(const item of page.items)assert.equal(item.actressId,expectedId++);cursor=page.nextAfterId}
    assert.equal(expectedId,count+1)
   } finally {snapshot.dispose()}
   assert.equal((db.prepare("SELECT count(*) AS n FROM sqlite_temp_master WHERE name LIKE 'avatar_crop_%'").get() as {n:number}).n,0)
   const tempAfterDispose={pageCount:db.pragma('temp.page_count',{simple:true}),freelistCount:db.pragma('temp.freelist_count',{simple:true})}
   results.push({actors:count,profileBytesPerActor:4096,metrics,tempInfo,tempAfterDispose,plan})
   closeDatabase();resetSettingsCacheForTests()
  }
  const output={runtime:{electron:process.versions.electron,node:process.versions.node},samplesPerMetric:20,p95Definition:'nearest rank ceil(0.95*20)=19th ordered observation',results,limits:['ANALYZE and warm-up; fixture just written, no cold-disk claim.','Fixed full-before-snapshot order; timings exclude assertions/serialization/disposal.','No isolated peak heap/RSS measurement; temp pager pages are not resident memory.','Actor-scale sensitivity, not Issue100 reported actor distribution or Windows/HDD/nativeIPC/model workload.']}
  console.log(JSON.stringify(output,null,2))
 } finally {closeDatabase();resetSettingsCacheForTests();if(previous===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previous;fs.rmSync(root,{recursive:true,force:true})}
})
