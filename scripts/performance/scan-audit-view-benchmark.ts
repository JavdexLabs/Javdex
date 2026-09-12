/** Actual combined-view index, with full historical builder as the field/order oracle. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../apps/desktop/src/main/db/database'
import {createScanAuditReadIndex} from '../../apps/desktop/src/main/services/scanAuditReadIndex'
import {buildScanAuditViewItems} from '../../packages/contracts/src/scanAuditView'
import type {LibraryScanAudit} from '../../packages/contracts/src/libraryTypes'
import type {ScanAuditViewQuery} from '../../packages/contracts/src/scanAuditReadTypes'
it('measures combined audit views against historical full-array output',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-view-probe-')),results:unknown[]=[]
 try{for(const count of [10000,300000]){
  const file=path.join(root,`${count}.db`),writer=initDatabaseAtPath(file)
  const identity={libraryId:1,runId:'probe',finishedAt:'2026-09-11T00:00:00Z'}
  const audit:LibraryScanAudit={...identity,schemaVersion:2,configRevision:1,trigger:'manual',startedAt:'before',status:'success',
   files:Array.from({length:count},(_,i)=>({rootId:1,filePath:`/media/${i}/${'x'.repeat(180)}.mp4`,sourceKind:'local',outcome:i%2?'skipped':'unrecognized',skipReason:'unchanged'})),
   removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
  writer.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('probe',1,1,'manual','completed','2026-09-11',?)").run(JSON.stringify(audit))
  const start=performance.now(),index=createScanAuditReadIndex(file,identity,{sourceBytes:128*1024*1024,indexBytes:256*1024*1024,pageBytes:1024*1024},{views:true})
  const buildMs=performance.now()-start,samples=[]
  try{
   for(const query of [{tab:'all'},{tab:'failed'},{tab:'skipped'},{tab:'all',search:'/media/29'}] as ScanAuditViewQuery[]){
    const all=buildScanAuditViewItems({audit,unrecognized:[],activeTab:query.tab,outcome:'all',changesFilter:'all'}),needle=(query.search??'').toLocaleLowerCase('en-US')
    const expected=needle?all.filter(item=>`${item.title} ${item.detail} ${item.path??''}`.toLocaleLowerCase('en-US').includes(needle)):all
    for(const offset of [0,Math.max(0,Math.floor((expected.length-1)/100)*100)]){
     const firstStart=performance.now()
     index.readViewPage({...query,offset,locale:'en-US'})
     const firstReadMs=performance.now()-firstStart
     for(let sample=0;sample<3;sample++){
      const start=performance.now(),page=index.readViewPage({...query,offset,locale:'en-US'}),elapsedMs=performance.now()-start
      assert.equal(page.total,expected.length);assert.deepEqual(page.items,expected.slice(offset,offset+100))
      samples.push({query,offset,firstReadMs,elapsedMs,jsonBytes:Buffer.byteLength(JSON.stringify(page))})
     }
    }
   }
   results.push({count,...index.getInfo(),buildMs,samples})
  }finally{index.dispose()}
  closeDatabase()
 }}finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
 console.log(JSON.stringify({results,notes:['Actual readonly factory with views=true; 128MiB source/256MiB TEMP/1MiB page.','One build per scale; firstReadMs includes cold query preparation on each first offset, then three warm samples. Full legacy oracle retained; assertions excluded. indexBytes reports initial index before derived match table, not runtime total.','No persistent unrecognized rows or resource changes in this timing fixture; mixed semantics covered by module tests.','Not p95/cold/Windows/HDD/UI/IPC/peak memory; SQL synchronous here, production worker integration still pending.']},null,2))
})
