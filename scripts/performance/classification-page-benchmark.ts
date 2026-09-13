/** Isolated synthetic classification list probe; run with run-electron-tests.mjs. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../packages/library/src/db/database'
import {classificationQueryService as read} from '../../apps/desktop/src/main/services/classificationQueryService'
it('compares complete entity lists to first/last pages with 100k associated videos',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-classification-bench-'))
 try {
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
    INSERT INTO organizations(id,main_name,updated_at) SELECT x,printf('Organization-%06d',x),'2026-01-01' FROM n;
    INSERT INTO organization_roles SELECT id,'maker' FROM organizations;
    INSERT INTO organization_names(organization_id,name,normalized_name,type) SELECT id,main_name,lower(main_name),'main' FROM organizations;
    INSERT INTO directors(id,main_name,updated_at) SELECT id,printf('Director-%06d',id),'2026-01-01' FROM organizations;
    INSERT INTO director_names(director_id,name,normalized_name,type) SELECT id,main_name,lower(main_name),'main' FROM directors;
    INSERT INTO series(id,main_name,owner_organization_id,updated_at) SELECT id,printf('Series-%06d',id),id,'2026-01-01' FROM organizations;
    INSERT INTO series_names(series_id,name,normalized_name,type) SELECT id,main_name,lower(main_name),'main' FROM series;
    WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
    INSERT INTO videos(id,code,maker_organization_id,series_id,director_id,cover_path,release_date,add_time)
      SELECT x,printf('VIDEO-%06d',x),(x%10000)+1,(x%10000)+1,(x%10000)+1,printf('cover/%06d.jpg',x),'2026-01-01','2026-01-01' FROM n;
    ANALYZE;`)
  const metrics:unknown[]=[],plans:unknown[]=[]
  for(const kind of ['maker','series','director'] as const) for(const sortBy of ['video_count','updated_at'] as const) {
    const query={sortBy,sortDir:'desc' as const}
    const full=()=>kind==='series'?read.listSeries(query):kind==='director'?read.listDirectors(query):read.listOrganizations({...query,role:kind})
    const expected=full()
    const measure=(name:string,run:()=>unknown,check:(v:unknown)=>void)=>{
      check(run());const samples:number[]=[];let bytes=0
      for(let n=0;n<3;n++){const start=performance.now(),value=run();samples.push(performance.now()-start);check(value);bytes=Buffer.byteLength(JSON.stringify(value))}
      metrics.push({kind,sortBy,name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes:bytes})
    }
    measure('legacy',full,value=>assert.deepEqual(value,expected))
    for(const offset of [0,9960]) {
      const prepare=db.prepare.bind(db)
      db.prepare=((sql:string)=>{if(sql.startsWith('WITH page AS MATERIALIZED'))plans.push({kind,sortBy,offset,plan:prepare('EXPLAIN QUERY PLAN '+sql).all(...(kind!=='maker'?['','',60,offset]:[kind,'','',60,offset]))});return prepare(sql)}) as typeof db.prepare
      let once=true
      const run=()=>{const result=kind==='series'?read.listSeriesPage({...query,offset}):kind==='director'?read.listDirectorsPage({...query,offset}):read.listOrganizationsPage({...query,role:kind,offset});if(once){db.prepare=prepare;once=false}return result}
      try {measure(offset?'last':'first',run,value=>{const page=value as {items:unknown[];total:number};assert.equal(page.total,10000);assert.deepEqual(page.items,expected.slice(offset,offset+60))})} finally{db.prepare=prepare}
    }
  }
  console.log(JSON.stringify({entitiesPerKind:10000,videos:100000,metrics,plans,notes:['Ten videos per entity; all update/release dates tied. ANALYZE, one warmup, 3 warm samples, fixed legacy-first ordering.','Timing excludes assertions/JSON serialization; complete oracle retained. No p95, cold, peak-memory, IPC or Windows/HDD claim.','Counts/ranking still scan entity/video relations; page payload and hydration are bounded, field byte lengths are not.']},null,2))
 }finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
