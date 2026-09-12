/** Exercises the actual isolated readonly/TEMP index, not the earlier same-writer decision probe. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../apps/desktop/src/main/db/database'
import {createScanAuditReadIndex} from '../../apps/desktop/src/main/services/scanAuditReadIndex'
it('measures actual audit index build and pages on synthetic large documents',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-index-probe-')),results:unknown[]=[]
 try{for(const count of [10000,300000]){
  const file=path.join(root,`${count}.db`),writer=initDatabaseAtPath(file)
  const identity={libraryId:1,runId:'probe',finishedAt:'2026-09-11T00:00:00Z'}
  const files=Array.from({length:count},(_,i)=>({rootId:1,filePath:`/media/${i}/${'x'.repeat(180)}.mp4`,sourceKind:'local',outcome:i%2?'skipped':'unrecognized',skipReason:'unchanged'}))
  const audit={...identity,schemaVersion:2,files,removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
  writer.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('probe',1,1,'manual','completed','2026-09-11',?)").run(JSON.stringify(audit))
  const start=performance.now(),index=createScanAuditReadIndex(file,identity,{sourceBytes:128*1024*1024,indexBytes:256*1024*1024,pageBytes:64*1024})
  const buildMs=performance.now()-start,samples=[]
  try{
   for(const offset of [0,count-100]){
    index.readPage({section:'files',offset})
    for(let sample=0;sample<3;sample++){
     const start=performance.now(),page=index.readPage({section:'files',offset}),elapsedMs=performance.now()-start
     assert.equal(page.total,count);assert.deepEqual(page.items.map(item=>item.entry),files.slice(offset,offset+100))
     samples.push({offset,elapsedMs,jsonBytes:Buffer.byteLength(JSON.stringify(page))})
    }
   }
   results.push({count,...index.getInfo(),buildMs,samples})
  }finally{index.dispose()}
  assert.equal(writer.pragma('query_only',{simple:true}),0)
  closeDatabase()
 }}finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
 console.log(JSON.stringify({results,notes:['Real factory opens native readonly source, FILE TEMP and explicit source128MiB/index256MiB/page64KiB limits; builds synchronously in this standalone probe.','Build includes opening, validation, five collection passes, indices and counts; read timings include byte checks and serialization budget enforcement, exclude assertions.','One build per scale, page warmup then 3 samples; long-path synthetic files, full oracle retained. Not p95/cold/Windows/HDD/worker IPC/peak memory evidence.','No global admission/worker/UI integration yet; TEMP cache8MiB does not bound total native parser or process memory. Deep OFFSET still scales.']},null,2))
})
