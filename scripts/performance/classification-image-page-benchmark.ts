/** Standalone synthetic cover candidate benchmark; no user data or media. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../packages/library/src/db/database'
import {classificationQueryService as read} from '../../apps/desktop/src/main/services/classificationQueryService'
it('compares full cover candidates with bounded pages',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-cover-page-bench-')),results:unknown[]=[]
 try{for(const count of [10000,50000]){
  const db=initDatabaseAtPath(path.join(root,`${count}.db`))
  db.exec(`INSERT INTO organizations(id,main_name) VALUES(1,'Org'); INSERT INTO directors(id,main_name) VALUES(1,'Director'); INSERT INTO series(id,main_name) VALUES(1,'Series');
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO videos(id,code,title,cover_path,release_date,add_time,maker_organization_id,publisher_organization_id,director_id,series_id)
      SELECT x,printf('VIDEO-%06d',x),hex(zeroblob(128)),printf('cover/%06d/',x)||hex(zeroblob(100))||'.jpg','2026-01-01','2026-01-01',1,1,1,1 FROM n;ANALYZE;`)
  for(const kind of ['organization','director','series'] as const){const entity={kind,id:1},expected=read.listImageCandidates(entity)
    for(const name of ['legacy','first','last']){const offset=name==='last'?Math.floor((count-1)/60)*60:0
      const run=()=>name==='legacy'?read.listImageCandidates(entity):read.listImageCandidatesPage(entity,{offset})
      const check=(value:ReturnType<typeof run>)=>{if(Array.isArray(value))assert.deepEqual(value,expected);else{assert.equal(value.total,count);assert.deepEqual(value.items,expected.slice(offset,offset+60))}}
      check(run());const samples:number[]=[];let jsonBytes=0
      for(let n=0;n<3;n++){const t=performance.now(),value=run();samples.push(performance.now()-t);check(value);jsonBytes=Buffer.byteLength(JSON.stringify(value))}
      results.push({count,kind,name,offset,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
    }
  }closeDatabase()
 }}finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
 console.log(JSON.stringify({results,notes:['All videos linked to the same entity, dual-role organization association, same dates; 256-char titles and >200-char cover paths.','ANALYZE, one warmup, 3 warm samples, fixed legacy-first order; assertion/JSON time excluded; full oracle retained.','No p95, IPC, cold, Windows/HDD, actual media, concurrent request or peak memory claim. Count/sort/deep offset remain data-dependent.']},null,2))
})
