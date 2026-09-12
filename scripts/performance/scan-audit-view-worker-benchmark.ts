/** Real worker responsiveness probe; synthetic audit only, no UI or production data. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {buildSync} from 'esbuild'
import {initDatabaseAtPath,closeDatabase,getDatabaseReadRevision} from '../../apps/desktop/src/main/db/database'
import {CatalogReadWorkerClient} from '../../apps/desktop/src/main/services/catalogReadWorkerClient'
import {createCatalogReadWorkerTransport} from '../../apps/desktop/src/main/services/catalogReadWorkerTransport'
it('measures responsiveness and shared-worker queuing for combined audit views',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-view-worker-probe-')),bundle=path.join(root,'worker.cjs')
 let client:CatalogReadWorkerClient|undefined,timer:ReturnType<typeof setInterval>|undefined
 try{
  buildSync({entryPoints:[path.resolve('apps/desktop/src/main/services/catalogReadWorker.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',tsconfig:path.resolve('tsconfig.node.json'),banner:{js:`require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});`}})
  const filename=path.join(root,'catalog.db'),db=initDatabaseAtPath(filename),count=300000
  const snapshot={libraryId:1,runId:'view-worker-probe',finishedAt:'2026-09-11T00:00:00Z'},limits={sourceBytes:128*1024*1024,indexBytes:256*1024*1024,pageBytes:1024*1024}
  const files=Array.from({length:count},(_,i)=>({rootId:1,filePath:`/media/${i}/${'x'.repeat(180)}.mp4`,sourceKind:'local',outcome:'skipped',skipReason:'unchanged'}))
  db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,1,1,'manual','completed','2026-09-11',?)").run(snapshot.runId,JSON.stringify({...snapshot,schemaVersion:2,files,removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}))
  client=new CatalogReadWorkerClient({contextProvider:()=>{const revision=getDatabaseReadRevision(db);return{identity:db,path:filename,revision:JSON.stringify([revision.changes,revision.dataVersion])}},transportFactory:context=>createCatalogReadWorkerTransport(bundle,context.path)})
  let callbacks=0,maxGapMs=0,last=performance.now()
  timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;callbacks++},2)
  const start=performance.now(),first=await client.readAuditViewPage(snapshot,{tab:'all'},limits),startupAndBuildMs=performance.now()-start
  const callbacksDuringBuild=callbacks
  await new Promise(resolve=>setTimeout(resolve,8));clearInterval(timer);timer=undefined
  assert.equal(first.total,count);assert.deepEqual(first.items.map(item=>item.path),files.slice(0,100).map(item=>item.filePath));assert.ok(callbacksDuringBuild>0)
  const samples=[]
  for(let i=0;i<4;i++){const start=performance.now(),page=await client.readAuditViewPage(snapshot,{tab:'all',offset:count-100},limits),elapsedMs=performance.now()-start;assert.deepEqual(page.items.map(item=>item.path),files.slice(-100).map(item=>item.filePath));if(i>0)samples.push(elapsedMs)}
  const searchStart=performance.now()
  const searchRequest=client.readAuditViewPage(snapshot,{tab:'all',search:'/media/29'},limits)
  const tagStart=performance.now(),tagRequest=client.read({}).then(result=>({result,elapsedMs:performance.now()-tagStart}))
  const [searched,tag]=await Promise.all([searchRequest,tagRequest])
  const searchAndQueuedTagMs=performance.now()-searchStart
  assert.equal(searched.total,files.filter(file=>file.filePath.includes('/media/29')).length)
  assert.equal(tag.result.items.length,0)
  console.log(JSON.stringify({count,startupAndBuildMs,searchAndQueuedTagMs,queuedTagMs:tag.elapsedMs,callbacksDuringBuild,maxTimerGapMs:maxGapMs,deepPageSamplesMs:samples,firstPageBytes:Buffer.byteLength(JSON.stringify(first)),notes:['2ms main-thread timer; one real worker startup/build and first combined-query preparation, warm filesystem; 8ms drain. Diagnostic timing, not p95 or universal latency bound.','Warm deep page one warmup+3 samples includes client context/message/copy; assertions excluded. Source oracle retained; no peak memory claim.','Includes one tag queued behind first search; no general fairness, UI/IPC handler, idle expiry timing, forced termination during native SQL, Windows/HDD or cold-disk evidence.']},null,2))
 }finally{if(timer)clearInterval(timer);await client?.dispose();closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
