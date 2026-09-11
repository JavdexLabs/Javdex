/** Synthetic merge candidate/count probe. No user DB or media access. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../src/main/db/database'
import {listActresses,listActressAvatarCropTargets} from '../../src/main/db/actressRepo'
import {resetSettingsCacheForTests} from '../../src/main/settings/settingsStore'
it('measures narrow avatar targets using user-approved ID order',()=>{
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
   UPDATE actresses SET avatar_path='avatars/'||id||'.jpg' WHERE id%3!=0;
   ANALYZE;`)
  const oracle=listActresses('','all')
  const expected=oracle.filter(row=>Boolean(row.avatar_source_path||row.avatar_path)).sort((a,b)=>a.id-b.id).map(row=>({actressId:row.id,mainName:row.main_name}))
  const results:Array<{name:string;samples:number[];medianMs:number;jsonBytes:number}>=[]
  function measure<T>(name:string,read:()=>T,check:(value:T)=>void){
   check(read());const samples:number[]=[];let jsonBytes=0
   for(let i=0;i<3;i++){const start=performance.now(),value=read();samples.push(performance.now()-start);check(value);jsonBytes=Buffer.byteLength(JSON.stringify(value))}
   results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes})
  }
  measure('legacy.full',()=>listActresses('','all'),value=>assert.deepEqual(value,oracle))
  measure('narrow.targets',()=>listActressAvatarCropTargets(),value=>assert.deepEqual(value,expected))
  console.log(JSON.stringify({actors:10000,videos:100000,memberships:150000,targets:expected.length,results,notes:['ANALYZE; warm-up then 3 warm samples, fixed legacy-first order.','Timing excludes assertion/serialization; oracle retained, no peak memory claim.','Full target list remains, work counting removed per user instruction; not bounded paging, p95, cold, Windows/HDD or IPC.']},null,2))
 } finally {closeDatabase();resetSettingsCacheForTests();if(previous===undefined)delete process.env.JAVDEX_TEST_USER_DATA;else process.env.JAVDEX_TEST_USER_DATA=previous;fs.rmSync(root,{recursive:true,force:true})}
})
