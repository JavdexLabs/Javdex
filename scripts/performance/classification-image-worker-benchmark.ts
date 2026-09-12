/** Standalone real worker / main-thread responsiveness comparison on a synthetic DB. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {buildSync} from 'esbuild'
import {getDatabaseReadRevision,initDatabaseAtPath,closeDatabase} from '../../packages/library/src/db/database'
import {listClassificationImagePage} from '../../apps/desktop/src/main/services/classificationImagePage'
import {CatalogReadWorkerClient} from '../../apps/desktop/src/main/services/catalogReadWorkerClient'
import {createCatalogReadWorkerTransport} from '../../apps/desktop/src/main/services/catalogReadWorkerTransport'
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
it('measures real read worker responsiveness without claiming faster SQL',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-image-worker-bench-')),bundle=path.join(root,'worker.cjs')
 let client:CatalogReadWorkerClient|undefined
 try {
  buildSync({entryPoints:[path.resolve('apps/desktop/src/main/services/catalogReadWorker.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',tsconfig:path.resolve('tsconfig.node.json'),banner:{js:`require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});`}})
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.exec(`INSERT INTO directors(id,main_name) VALUES(1,'Director');
   WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000)
   INSERT INTO videos(id,code,title,cover_path,release_date,add_time,director_id)
    SELECT x,printf('VIDEO-%06d',x),hex(zeroblob(128)),printf('cover/%06d/',x)||hex(zeroblob(100))||'.jpg','2026-01-01','2026-01-01',1 FROM n;ANALYZE;`)
  let dispatches=0
  client=new CatalogReadWorkerClient({contextProvider:()=>{const revision=getDatabaseReadRevision(db);return{identity:db,path:db.name,revision:JSON.stringify([revision.changes,revision.dataVersion,db.pragma('schema_version',{simple:true})])}},transportFactory:context=>{
   const transport=createCatalogReadWorkerTransport(bundle,context.path),post=transport.postMessage.bind(transport)
   transport.postMessage=((message:unknown)=>{if((message as {type:string}).type==='read')dispatches++;post(message)}) as typeof transport.postMessage
   return transport
  }})
  const entity={kind:'director' as const,id:1},query={limit:60,offset:49980},expected=listClassificationImagePage(entity,query)
  const startup=performance.now();assert.deepEqual(await client.readImageCandidates(entity,query),expected);const startupAndFirstReadMs=performance.now()-startup
  const samples:unknown[]=[]
  for(const mode of ['writer','worker'] as const){
   const run=()=>mode==='writer'?listClassificationImagePage(entity,query):client!.readImageCandidates(entity,query)
   assert.deepEqual(await run(),expected)
   for(let sample=0;sample<3;sample++){
    let last=performance.now(),during=0;const gaps:number[]=[]
    const timer=setInterval(()=>{const now=performance.now();gaps.push(now-last);last=now;during++},2)
    try{
     await delay(10);gaps.length=0;during=0;last=performance.now()
     const start=performance.now(),value=await run(),elapsedMs=performance.now()-start,callbacksDuringRead=during
     await delay(8)
     assert.deepEqual(value,expected)
     samples.push({mode,sample,elapsedMs,callbacksDuringRead,maxTimerGapMs:Math.max(...gaps),jsonBytes:Buffer.byteLength(JSON.stringify(value))})
    }finally{clearInterval(timer)}
   }
  }
  const before=dispatches,coalesced=await Promise.all(Array.from({length:32},()=>client!.readImageCandidates(entity,query)))
  assert.equal(dispatches-before,1);assert.equal(coalesced.length,32)
  coalesced[0].items[0].code='mutated';assert.notEqual(coalesced[1].items[0].code,'mutated')
  console.log(JSON.stringify({startupAndFirstReadMs,samples,coalescedSubscribers:32,coalescedDispatches:dispatches-before,notes:['50k videos / same director, date ties, 256-char titles and >200-char cover paths; existing deep OFFSET query unchanged.','One warmup then three samples per mode, writer first; 2ms interval before read, 8ms drain afterwards. Timer gaps are diagnostic samples, not p95 or a universal frame bound.','Worker timing includes queue/message/copy/context overhead; first read includes worker startup. All file data seeded locally/warm OS cache; no cold/Windows/HDD or main-process IPC claim.','Oracle/assertions/JSON excluded from timed read; full data retained, no peak memory claim. Native interruption/termination limits and byte budgets remain.']},null,2))
 }finally{await client?.dispose();closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
