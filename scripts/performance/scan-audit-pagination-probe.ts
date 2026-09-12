/** Synthetic decision probe only; TEMP index is not production code or a migration. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../packages/library/src/db/database'

type Entry={rootId:number;filePath:string;sourceKind:string;outcome:string;nfo?:{disposition:string}}
const attention=(e:Entry)=>['unrecognized','strm_failure','processing_failure'].includes(e.outcome)||['warning','identity-conflict','pending-candidate'].includes(e.nfo?.disposition??'')
const attentionSql="(json_extract(value,'$.outcome') IN ('unrecognized','strm_failure','processing_failure') OR COALESCE(json_extract(value,'$.nfo.disposition') IN ('warning','identity-conflict','pending-candidate'),0))"
it('compares audit pagination costs and validates ordered full-field results',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-audit-page-probe-')),results:unknown[]=[]
 try{for(const count of [10000,100000,300000]){
  const db=initDatabaseAtPath(path.join(root,`${count}.db`))
  const files:Entry[]=Array.from({length:count},(_,i)=>({rootId:1,filePath:`/media/${String(i).padStart(6,'0')}/${'x'.repeat(180)}.mp4`,sourceKind:i%2?'local':'strm',outcome:['added','updated','skipped','unrecognized','strm_failure'][i%5],...(i%7===0?{nfo:{disposition:'warning'}}:{})}))
  const raw=JSON.stringify({schemaVersion:2,libraryId:1,runId:'probe',files,removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]})
  db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('probe',1,1,'manual','completed','2026-09-11',?)").run(raw)
  const materializeStart=performance.now()
  db.exec(`CREATE TEMP TABLE audit_page_probe(ordinal INTEGER PRIMARY KEY,entry TEXT NOT NULL,outcome TEXT NOT NULL,attention INTEGER NOT NULL);
    INSERT INTO audit_page_probe SELECT CAST(key AS INTEGER),value,json_extract(value,'$.outcome'),${attentionSql}
    FROM library_scan_runs r,json_each(r.audit_json,'$.files') WHERE r.id='probe' AND r.library_id=1;
    CREATE INDEX temp.audit_page_probe_outcome ON audit_page_probe(outcome,ordinal);
    CREATE INDEX temp.audit_page_probe_attention ON audit_page_probe(attention,ordinal);`)
  const materializeMs=performance.now()-materializeStart
  const tempPages=db.pragma('temp.page_count',{simple:true}) as number,tempPageSize=db.pragma('temp.page_size',{simple:true}) as number
  for(const filter of ['all','attention','skipped']){
   const expected=files.filter(e=>filter==='all'||(filter==='attention'?attention(e):e.outcome==='skipped'))
   const directWhere=filter==='all'?'1':filter==='attention'?attentionSql:"json_extract(value,'$.outcome')='skipped'"
   const indexedWhere=filter==='all'?'1':filter==='attention'?'attention=1':"outcome='skipped'"
   for(const offset of [0,Math.floor((expected.length-1)/100)*100]){
    for(const mode of ['whole-json','cached-view','json-page','indexed-page']){
     const run=()=>{
      if(mode==='cached-view') return {total:expected.length,items:expected.slice(offset,offset+100)}
      return db.transaction(()=>{
      if(mode==='whole-json'){
       const row=db.prepare("SELECT audit_json FROM library_scan_runs WHERE id='probe' AND library_id=1").get() as {audit_json:string}
       const entries=(JSON.parse(row.audit_json) as {files:Entry[]}).files.filter(e=>filter==='all'||(filter==='attention'?attention(e):e.outcome==='skipped'))
       return {total:entries.length,items:entries.slice(offset,offset+100)}
      }
      const from=mode==='json-page'?"library_scan_runs r,json_each(r.audit_json,'$.files') WHERE r.id='probe' AND r.library_id=1 AND "+directWhere:'audit_page_probe WHERE '+indexedWhere
      const total=(db.prepare('SELECT COUNT(*) AS n FROM '+from).get() as {n:number}).n
      const rows=db.prepare(`SELECT ${mode==='json-page'?'value':'entry'} AS entry FROM ${from} ORDER BY ${mode==='json-page'?'CAST(key AS INTEGER)':'ordinal'} LIMIT 100 OFFSET ?`).all(offset) as {entry:string}[]
      return {total,items:rows.map(row=>JSON.parse(row.entry) as Entry)}
     })()
     }
     const check=(v:ReturnType<typeof run>)=>{assert.equal(v.total,expected.length);assert.deepEqual(v.items,expected.slice(offset,offset+100))}
     check(run());const samples:number[]=[];let pageBytes=0
     for(let i=0;i<3;i++){const start=performance.now(),value=run();samples.push(performance.now()-start);check(value);pageBytes=Buffer.byteLength(JSON.stringify(value))}
     results.push({count,rawBytes:Buffer.byteLength(raw),materializeMs,tempAllocatedBytes:tempPages*tempPageSize,filter,offset,mode,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],pageBytes})
    }
   }
  }closeDatabase()
 }}finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
 console.log(JSON.stringify({results,notes:['Synthetic files only; full oracle and raw JSON retained. Count/page within one transaction; exact fields/order checked.','One warmup +3 samples per variant; whole-json/cached-view/direct-json/TEMP-index, construction before all samples. Indexed timings exclude construction; cached-view uses already filtered retained oracle (no filter/map initialization included).','TEMP allocated bytes are SQLite page allocation, not RSS/peak or disk I/O; storage may use memory depending on runtime configuration.','Not production, not a migration: actual readonly worker query_only forbids TEMP writes. Worker/index ownership and recovery must be designed before adoption.','No UI-search/localization, extra unrecognized merge, groups/changes, real IPC, cancellation, cold disk, Windows/HDD, p95 or mixed load claims.']},null,2))
})
