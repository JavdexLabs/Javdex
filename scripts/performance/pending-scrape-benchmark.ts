/** Synthetic inbox only. Compare old full hydration with bounded summary/read-on-select. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { getPendingAuditPresence } from '../../apps/desktop/src/main/db/pendingAuditRepo'
import { closeDatabase, initDatabaseAtPath } from '../../apps/desktop/src/main/db/database'
import { getPendingVideoScrapeById, existingPendingVideoScrapeIds, listPendingVideoScrapes, pagePendingVideoScrapes } from '../../apps/desktop/src/main/db/pendingVideoScrapeRepo'

it('measures 10k pending summaries against full candidate hydration', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-pending-bench-'))
  try {
    const db=initDatabaseAtPath(path.join(root,'catalog.db'))
    db.transaction(()=>{
      db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO videos(id,code) SELECT x,'PENDING-'||x FROM n;
        INSERT INTO pending_video_scrapes(id,video_id,selected_fields_json,applicable_fields_json,update_mode,request_json,warnings_json,created_at,updated_at)
          SELECT id,id,'[]','[]','replace','{}','[]','2026','2026' FROM videos;
        INSERT INTO pending_video_scrape_sources(id,pending_scrape_id,position,plugin_name,plugin_source,source_name,selected_fields_json,plugin_config_json)
          SELECT id,id,0,'p','builtin','s','[]','{}' FROM videos;`)
      const insert=db.prepare('INSERT INTO pending_video_scrape_candidates(id,source_id,position,result_json) VALUES(?,?,0,?)')
      for(let id=1;id<=10000;id++)insert.run(id,id,JSON.stringify({code:`CANDIDATE-${id}`,summary:'x'.repeat(4096),tags:['one','two']}))
      db.exec(`INSERT INTO media_library_roots(id,library_id,path,normalized_path) VALUES(1,1,'/synthetic','/synthetic');
        INSERT INTO pending_scan_groups(id,library_id,normalized_code) SELECT id,1,'GROUP-'||id FROM videos;
        INSERT INTO pending_resource_identities(id,library_id,root_id,file_path,normalized_path,source_kind,filename_code,nfo_code)
          SELECT id,1,1,'/synthetic/'||id,'/synthetic/'||id,'local','FILE-'||id,'NFO-'||id FROM videos;
        INSERT INTO pending_video_scrape_resources(candidate_id,field,position,staged_path,size_bytes)
        SELECT id,'cover',0,'staged/'||id||'.jpg',1000 FROM videos;`)
    })()
    db.exec('ANALYZE')
    const expected=Array.from({length:50},(_,i)=>({id:i+1,videoId:i+1,revision:1,code:`CANDIDATE-${i+1}`,candidateCount:1,sourceCount:1,stagedCoverPath:`staged/${i+1}.jpg`}))
    const results=[]
    function measure(name:string,read:()=>unknown,verify:(value:unknown)=>void) {
      const samples=[];let jsonBytes=0
      for(let i=0;i<3;i++){
        const start=performance.now();const value=read();const elapsed=performance.now()-start
        verify(value);jsonBytes=Buffer.byteLength(JSON.stringify(value));samples.push(elapsed)
      }
      results.push({name,samples,medianMs:[...samples].sort((a,b)=>a-b)[1],jsonBytes,rssBytes:process.memoryUsage().rss})
    }
    measure('full.list',listPendingVideoScrapes,value=>{const rows=value as ReturnType<typeof listPendingVideoScrapes>;assert.equal(rows.length,10000);assert.equal(rows[9999].sources[0].candidates[0].result.summary!.length,4096)})
    measure('summary.first',()=>pagePendingVideoScrapes({}),value=>assert.deepEqual(value,{items:expected,total:10000,offset:0}))
    measure('summary.deep',()=>pagePendingVideoScrapes({anchorId:9876}),value=>{const page=value as ReturnType<typeof pagePendingVideoScrapes>;assert.equal(page.offset,9850);assert.ok(page.items.some(row=>row.id===9876))})
    measure('detail.selected',()=>getPendingVideoScrapeById(9876),value=>{const item=value as NonNullable<ReturnType<typeof getPendingVideoScrapeById>>;assert.equal(item.videoId,9876);assert.equal(item.sources[0].candidates[0].result.summary!.length,4096)})
    const auditIds=Array.from({length:100},(_,i)=>9901+i)
    measure('existing.ids100',()=>existingPendingVideoScrapeIds(auditIds),value=>assert.deepEqual(value,auditIds))
    const mixed={groupIds:Array.from({length:34},(_,i)=>9967+i),identityIds:Array.from({length:33},(_,i)=>9968+i),scrapeIds:Array.from({length:33},(_,i)=>9968+i)}
    measure('audit.presence.mixed100',()=>getPendingAuditPresence(1,mixed),value=>assert.deepEqual(value,mixed))
    const result={count:10000,scanGroups:10000,resourceIdentities:10000,candidatesPerItem:1,summaryCharacters:4096,results,platform:process.platform,arch:process.arch,
      sqliteVersion:db.prepare('SELECT sqlite_version() AS version').get(),
      caveats:['Three sequential local warm samples on synthetic catalog; not p95/Windows/HDD/full renderer IPC.',
        'Times cover repository calls only; assertions and JSON sizing excluded. Bytes are JSON-equivalent payload, not actual IPC allocations.',
        'First metadata page reads at most50 item metadata, but candidate counts/first-candidate JSON extraction and OFFSET/rank are not constant SQL work.',
        'RSS is sampled after each stage, not peak or independent allocation; full hydration runs first. No OS cache reset.']}
    if(process.env.JAVDEX_PENDING_BENCH_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_PENDING_BENCH_OUTPUT),JSON.stringify(result,null,2)+'\n')
    console.log(JSON.stringify(result))
  } finally {closeDatabase();fs.rmSync(root,{recursive:true,force:true})}
})
