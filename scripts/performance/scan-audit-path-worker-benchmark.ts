/** Real-worker permission scan: one entry at a time in JS; no production data. */
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
it('measures responsiveness during large audit permission scans on the real worker',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-path-worker-')),bundle=path.join(root,'worker.cjs')
 let client:CatalogReadWorkerClient|undefined,timer:ReturnType<typeof setInterval>|undefined
 try{
  buildSync({entryPoints:[path.resolve('apps/desktop/src/main/services/catalogReadWorker.ts')],outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',tsconfig:path.resolve('tsconfig.node.json'),banner:{js:`require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});`}})
  const filename=path.join(root,'catalog.db'),db=initDatabaseAtPath(filename),count=300000
  const files=Array.from({length:count},(_,i)=>({rootId:1,filePath:`/media/${i}/${'x'.repeat(180)}.mp4`,sourceKind:'local',outcome:'skipped',skipReason:'unchanged'}))
  const audit={schemaVersion:2,libraryId:1,runId:'permission',configRevision:1,trigger:'manual',status:'success',startedAt:'before',finishedAt:'now',files,removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
  const body=JSON.stringify(audit)
  db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('permission',1,1,'manual','completed','before',?)").run(body)
  client=new CatalogReadWorkerClient({contextProvider:()=>{const revision=getDatabaseReadRevision(db);return{identity:db,path:filename,revision:JSON.stringify([revision.changes,revision.dataVersion])}},transportFactory:context=>createCatalogReadWorkerTransport(bundle,context.path)})
  let callbacks=0,maxGapMs=0,last=performance.now()
  timer=setInterval(()=>{const now=performance.now();maxGapMs=Math.max(maxGapMs,now-last);last=now;callbacks++},2)
  const start=performance.now(),allowed=await client.canRevealAuditPath(1,files[count-1].filePath),startupAndPermissionMs=performance.now()-start
  const callbacksDuringWait=callbacks
  await new Promise(resolve=>setTimeout(resolve,8));clearInterval(timer);timer=undefined
  assert.equal(allowed,true);assert.ok(callbacksDuringWait>0)
  const warmPermissionMs=[]
  for(let i=0;i<3;i++){const start=performance.now();assert.equal(await client.canRevealAuditPath(1,files[0].filePath),true);warmPermissionMs.push(performance.now()-start)}
  console.log(JSON.stringify({count,sourceBytes:Buffer.byteLength(body),startupAndPermissionMs,callbacksDuringWait,maxTimerGapMs:maxGapMs,warmPermissionMs,notes:['Full legacy audit validation still O(N), even if the target occurs first; this moves work off the main thread and removes whole-body JS parsing, not all native parsing.','One startup plus three repeated reads; warm filesystem and retained source oracle. No p95/cold/platform/peak-memory/real-shell benchmark.','2ms main timer, max gap includes8ms drain. Shared worker remains occupied during checks; no fairness claim.']},null,2))
 }finally{if(timer)clearInterval(timer);await client?.dispose();closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
