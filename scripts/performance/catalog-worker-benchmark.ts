/** Built production worker/client on a disposable large catalog; no Electron UI or user DB. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { initDatabaseAtPath, closeDatabase, getDatabaseReadRevision } from '../../src/main/db/database'
import { listTagFilterOptions } from '../../src/main/db/tagRepo'
import { CatalogReadWorkerClient } from '../../src/main/services/catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from '../../src/main/services/catalogReadWorkerTransport'

it('measures actual built-worker reads and main event-loop responsiveness on a large catalog', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'javdex-catalog-worker-bench-'))
  const videos=Number(process.env.JAVDEX_WORKER_BENCH_VIDEOS ?? 300382)
  assert.ok(Number.isSafeInteger(videos) && videos>=1000 && videos<=300382)
  let client: CatalogReadWorkerClient | undefined
  let interval: ReturnType<typeof setInterval> | undefined
  try {
    const file=path.join(root,'catalog.db')
    const db=initDatabaseAtPath(file)
    db.transaction(()=>{
      db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<${videos})
        INSERT INTO videos(id,code) SELECT x,'WORKER-'||x FROM n;
        INSERT INTO library_video_memberships(library_id,video_id,added_at,discovery_key) SELECT 1,id,'2026',id FROM videos;
        WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000)
        INSERT INTO tags(id,name) SELECT x,'Tag '||x FROM n;`)
      for(let offset=0;offset<4;offset++)db.exec(`INSERT INTO video_tag(video_id,tag_id,origin) SELECT id,1+(id+${offset})%1000,CASE WHEN id%7=0 THEN 'manual' ELSE 'scraped' END FROM videos`)
    })()
    db.exec('ANALYZE')
    client=new CatalogReadWorkerClient({contextProvider:()=>{
      const revision=getDatabaseReadRevision(db)
      return {identity:db,path:file,revision:JSON.stringify([revision.changes,revision.dataVersion])}
    },transportFactory:context=>createCatalogReadWorkerTransport(path.resolve('out/main/catalogReadWorker.js'),context.path)})
    const expected=listTagFilterOptions({})
    let last=performance.now(),maxGap=0,ticks=0
    interval=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++},5)
    const results=[]
    async function measure(name: string, action: () => unknown | Promise<unknown>) {
      maxGap=0;last=performance.now();ticks=0
      const times=[]
      for(let i=0;i<3;i++){
        await new Promise(resolve=>setTimeout(resolve,10))
        const start=performance.now()
        assert.deepEqual(await action(),expected)
        times.push(performance.now()-start)
      }
      await new Promise(resolve=>setTimeout(resolve,10))
      results.push({name,times,medianMs:[...times].sort((a,b)=>a-b)[1],maxTimerGapMs:maxGap,ticks,rssBytes:process.memoryUsage().rss})
    }
    await measure('main.repository',()=>listTagFilterOptions({}))
    const started=performance.now()
    assert.deepEqual(await client.read({}),expected)
    const firstWorkerReadMs=performance.now()-started
    await measure('worker.cached',()=>client!.read({}))
    await measure('worker.invalidated',()=>{
      db.exec("UPDATE videos SET updated_at=COALESCE(updated_at,'') || '.' WHERE id=1")
      return client!.read({})
    })
    await client.dispose()
    const output={videos,firstWorkerReadMs,results,versions:process.versions,platform:process.platform,arch:process.arch,
      caveats:['Synthetic narrow tag fixture, three local warm samples, not p95/customer Windows/HDD/full renderer IPC.',
        'Timing includes result equality assertions; timer sampling and fixed inter-sample delays affect gap statistics.',
        'First worker read includes startup and cache miss; later invalidated samples include a committed video timestamp change that leaves the tag result unchanged.',
        'Worker transport is built production entry/client; native SQLite termination is not a hard SQL interrupt.']}
    if(process.env.JAVDEX_WORKER_BENCH_OUTPUT)fs.writeFileSync(path.resolve(process.env.JAVDEX_WORKER_BENCH_OUTPUT),JSON.stringify(output,null,2)+'\n')
    console.log(JSON.stringify(output))
  } finally {
    if(interval)clearInterval(interval)
    await client?.dispose()
    closeDatabase();fs.rmSync(root,{recursive:true,force:true})
  }
})
