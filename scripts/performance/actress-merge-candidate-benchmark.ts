/** Synthetic merge candidate/count probe. No user DB or media access. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../src/main/db/database'
import {listActresses,listActressMergeCandidates} from '../../src/main/db/actressRepo'
import {canMergeActressGenders} from '../../src/shared/actressProfileOptions'
import {resetSettingsCacheForTests} from '../../src/main/settings/settingsStore'
it('measures merge candidate pages with visible-video counts',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-merge-probe-')),previous=process.env.JAVDEX_TEST_USER_DATA
 process.env.JAVDEX_TEST_USER_DATA=root;resetSettingsCacheForTests()
 try {
  const db=initDatabaseAtPath(path.join(root,'catalog.db'))
  db.exec(`
   WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
   INSERT INTO actresses(id,main_name,gender,profile_summary)
    SELECT x,printf('Actor-%05d',x),CASE WHEN x%3=0 THEN 'male' WHEN x%7=0 THEN NULL ELSE 'female' END,hex(zeroblob(2048)) FROM n;
   INSERT INTO actress_names(actress_id,name,type,source) SELECT id,main_name,'main','manual' FROM actresses;
   INSERT INTO actress_name_ownership(normalized_name,actress_id) SELECT normalize_actress_name(main_name),id FROM actresses;
   WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000)
   INSERT INTO videos(id,code) SELECT x,printf('VIDEO-%06d',x) FROM n;
   INSERT OR IGNORE INTO media_libraries(id,name) VALUES(1,'Active'),(2,'Overlap');
   INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT 1,id,id FROM videos;
   INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT 2,id,id FROM videos WHERE id%2=0;
   INSERT INTO video_actress(video_id,actress_id) SELECT id,((id-1)%10000)+1 FROM videos;
   ANALYZE;`)
  const oracle=listActresses('','all')
  const expected=oracle.filter(row=>row.id!==1&&canMergeActressGenders('female',row.gender))
   .sort((a,b)=>Buffer.compare(Buffer.from(a.main_name),Buffer.from(b.main_name)))
   .map(({id,main_name,gender,avatar_path,video_count})=>({id,main_name,gender,avatar_path,video_count}))
  const results:Array<{name:string;samples:number[];medianMs:number;jsonBytes:number}>=[]
  function measure<T>(name:string,read:()=>T,check:(value:T)=>void){
   check(read());const samples:number[]=[];let jsonBytes=0
   for(let i=0;i<3;i++){const start=performance.now(),value=read();samples.push(performance.now()-start);check(value);jsonBytes=Buffer.byteLength(JSON.stringify(value))}
   results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
  }
  let countSql=''
  const prepare=db.prepare.bind(db)
  db.prepare=((sql:string)=>{if(sql.includes('FROM video_actress va')&&sql.includes('json_each'))countSql=sql;return prepare(sql)}) as typeof db.prepare
  try {
   measure('legacy.full',()=>listActresses('','all'),value=>assert.deepEqual(value,oracle))
   measure('merge.first40',()=>listActressMergeCandidates({keepId:1}),value=>assert.deepEqual(value,{items:expected.slice(0,40),hasMore:true,offset:0}))
   const offset=Math.floor((expected.length-1)/40)*40
   measure('merge.last40',()=>listActressMergeCandidates({keepId:1,offset}),value=>assert.deepEqual(value,{items:expected.slice(offset),hasMore:false,offset}))
  } finally {db.prepare=prepare}
  // One off-page eligible actor owns200k extra works; check index choice under skew.
  db.exec(`WITH RECURSIVE n(x) AS(VALUES(100001) UNION ALL SELECT x+1 FROM n WHERE x<300000)
    INSERT INTO videos(id,code) SELECT x,printf('VIDEO-%06d',x) FROM n;
    INSERT INTO library_video_memberships(library_id,video_id,discovery_key) SELECT 1,id,id FROM videos WHERE id>100000;
    INSERT INTO video_actress(video_id,actress_id) SELECT id,9998 FROM videos WHERE id>100000;
    ANALYZE;`)
  const skewed=expected.map(row=>row.id===9998?{...row,video_count:row.video_count+200000}:row)
  measure('skew.merge.first40',()=>listActressMergeCandidates({keepId:1}),value=>assert.deepEqual(value,{items:skewed.slice(0,40),hasMore:true,offset:0}))
  const lastOffset=Math.floor((skewed.length-1)/40)*40
  measure('skew.merge.last40',()=>listActressMergeCandidates({keepId:1,offset:lastOffset}),value=>assert.deepEqual(value,{items:skewed.slice(lastOffset),hasMore:false,offset:lastOffset}))
  assert.ok(countSql)
  const countPlan=db.prepare('EXPLAIN QUERY PLAN '+countSql).all(JSON.stringify(expected.slice(0,40).map(row=>row.id)))
  assert.match(JSON.stringify(countPlan),/SEARCH va USING INDEX idx_video_actress_actress_id/)
  const report={actors:10000,videos:100000,videoActressEdges:100000,memberships:150000,eligible:expected.length,skewPhase:{videos:300000,videoActressEdges:300000,memberships:350000,hotActressId:9998,extraWorks:200000},results,countPlan,
   sqlite:db.prepare('SELECT sqlite_version() AS version').get(),platform:process.platform,
   notes:['Synthetic4KiB profiles,10videos/actor with50k overlapping memberships;ANALYZE,warm-up,3warm samples,notp95/cold/Windows/HDD/IPC/UI.',
    'Picker sorts by full name, unlike legacy video count. Oracle filtered for merge eligibility and explicitly re-sorted before projection comparison.',
    'Skew phase adds200k works to last-page actor9998, then ANALYZE. First-page exclusion and last-page inclusion checked; final countPlan captured after skew using first-page IDs. High per-actor fanout still costs work; deep OFFSET walks earlier rows.',
    'Oracle held in memory; no peak RSS claim. Timing excludes assertions and serialization; bytes are JSON responses.']}
  if(process.env.JAVDEX_MERGE_CANDIDATE_OUTPUT)fs.writeFileSync(process.env.JAVDEX_MERGE_CANDIDATE_OUTPUT,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report))
 } finally {closeDatabase();resetSettingsCacheForTests();if(previous===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previous;fs.rmSync(root,{recursive:true,force:true})}
})
