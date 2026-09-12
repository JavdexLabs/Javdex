/** Standalone synthetic cleanup-reference probe; never opens user data. */
import {it} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {initDatabaseAtPath,closeDatabase} from '../../apps/desktop/src/main/db/database'
import {iterateSourceManagedVideoResourceRefs,listSourceManagedVideoResourceRefs} from '../../apps/desktop/src/main/db/videoRepo'
it('measures bounded cleanup enumeration without claiming bounded audit memory',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-source-probe-')),results:unknown[]=[]
 try {for(const count of [50000,300000]){
  const db=initDatabaseAtPath(path.join(root,`${count}.db`))
  db.exec(`INSERT INTO videos(id,code) VALUES(1,'SOURCE');
    INSERT INTO library_video_memberships(library_id,video_id,discovery_key) VALUES(1,1,1);
    WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${count})
    INSERT INTO video_resources(library_id,video_id,kind,locator,resource_key,source_identity)
    SELECT 1,1,'local','path/'||x||hex(zeroblob(100)), 'key/'||x,'identity/'||x FROM n; ANALYZE;`)
  for(const mode of ['full','paged']){
   const samples=[]
   for(let sample=-1;sample<3;sample++){
    const result=db.transaction(()=>{
     const start=performance.now()
     const refs=mode==='full'?listSourceManagedVideoResourceRefs(1):iterateSourceManagedVideoResourceRefs(1)
     let rows=0,checksum=0,firstMs=0
     for(const ref of refs){if(!rows)firstMs=performance.now()-start;rows++;checksum+=ref.resource_id}
     return {elapsedMs:performance.now()-start,firstMs,rows,checksum}
    })()
    assert.equal(result.rows,count);assert.equal(result.checksum,count*(count+1)/2)
    if(sample>=0)samples.push(result)
   }
   results.push({count,mode,samples})
  }closeDatabase()
 }}finally{closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
 console.log(JSON.stringify({results,notes:['Single library, >200-character paths, ANALYZE; one warmup and 3 samples, full first.','Includes enumeration/checksum loop but excludes assertions; firstMs measures first consumer access.','Paged reference arrays at most256 (separate correctness test); total cleanup/audit memory, filesystem time, p95, cold I/O and sparse multi-library distributions not measured.','All enumeration synchronous within original cleanup transaction; no event-loop yielding or shorter writer transaction claimed.']},null,2))
})
