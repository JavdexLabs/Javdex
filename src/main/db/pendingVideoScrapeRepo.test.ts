import { it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabaseAtPath, closeDatabase } from './database'
import { countPendingVideoScrapes, existingPendingVideoScrapeIds, pagePendingVideoScrapes, getPendingVideoScrapeById } from './pendingVideoScrapeRepo'

it('counts a large pending inbox without decoding its snapshots and follows deletions', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pending-count-'))
  try {
    const db = initDatabaseAtPath(path.join(directory, 'test.db'))
    assert.equal(countPendingVideoScrapes(), 0)
    const video = db.prepare('INSERT INTO videos (id, code) VALUES (?, ?)')
    const pending = db.prepare(`INSERT INTO pending_video_scrapes (
      video_id, selected_fields_json, applicable_fields_json, update_mode,
      request_json, warnings_json, created_at, updated_at
    ) VALUES (?, 'not-json', 'not-json', 'replace', 'not-json', 'not-json', '2026', '2026')`)
    db.transaction(() => {
      for (let id = 1; id <= 10_000; id++) {
        video.run(id, `COUNT-${id}`)
        pending.run(id)
      }
    })()
    const trace: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = ((sql: string) => {
      trace.push(sql)
      return prepare(sql)
    }) as typeof db.prepare
    assert.equal(countPendingVideoScrapes(), 10_000)
    assert.deepEqual(trace, ['SELECT COUNT(*) AS count FROM pending_video_scrapes'])
    assert.deepEqual(existingPendingVideoScrapeIds([10000,1,1,20000]),[1,10000])
    assert.ok(trace.at(-1)!.startsWith('SELECT id FROM pending_video_scrapes WHERE id IN'))
    assert.deepEqual(existingPendingVideoScrapeIds([]),[])
    assert.throws(()=>existingPendingVideoScrapeIds(Array(101).fill(1)),/Invalid/)
    assert.throws(()=>existingPendingVideoScrapeIds([Number.MAX_SAFE_INTEGER+1]),/Invalid/)
    db.prepare('DELETE FROM pending_video_scrapes WHERE video_id = ?').run(1)
    assert.equal(countPendingVideoScrapes(), 9_999)
    db.prepare('DELETE FROM videos WHERE id = ?').run(2)
    assert.equal(countPendingVideoScrapes(), 9_998)
  } finally {
    closeDatabase()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})


it('pages a 10k inbox without materializing snapshots, locates deep links and clamps deleted pages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-pending-page-'))
  try {
    const db = initDatabaseAtPath(path.join(directory, 'test.db'))
    db.transaction(() => {
      db.exec(`WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO videos(id,code) SELECT x,'PAGE-'||x FROM n;
        INSERT INTO pending_video_scrapes(id,video_id,selected_fields_json,applicable_fields_json,update_mode,request_json,warnings_json,created_at,updated_at)
          SELECT id,id,'not-json','not-json','replace','not-json','not-json','2026','2026' FROM videos;
        INSERT INTO pending_video_scrape_sources(id,pending_scrape_id,position,plugin_name,plugin_source,source_name,selected_fields_json,plugin_config_json)
          SELECT id,id,0,'p','builtin','s','not-json','not-json' FROM videos;
        INSERT INTO pending_video_scrape_candidates(id,source_id,position,result_json)
          SELECT id,id,0,'not-json' FROM videos;`)
      db.prepare('UPDATE pending_video_scrape_candidates SET result_json=? WHERE id=1').run(JSON.stringify({ code: '　'.repeat(200) + '😀'.repeat(130), summary: 'x'.repeat(1_000_000) }))
      db.exec("INSERT INTO pending_video_scrape_sources(id,pending_scrape_id,position,plugin_name,plugin_source,source_name,selected_fields_json,plugin_config_json) VALUES(10001,1,-1,'empty','builtin','empty','[]','{}')")
      db.exec("INSERT INTO pending_video_scrape_resources(candidate_id,field,position,staged_path) VALUES(1,'cover',0,'cover-one.jpg'),(1,'samples',0,'sample.jpg')")
    })()
    const first = pagePendingVideoScrapes({ limit: 50 })
    assert.equal(first.total, 10000); assert.equal(first.items.length, 50)
    assert.equal(first.items[0].code, '😀'.repeat(128)+'…')
    assert.equal(first.items[0].stagedCoverPath, 'cover-one.jpg')
    assert.equal(first.items[0].candidateCount, 1); assert.equal(first.items[0].sourceCount, 2)
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < 16*1024)
    assert.equal('sources' in first.items[0], false)
    assert.equal(first.items[1].code, '')
    assert.equal(getPendingVideoScrapeById(1)!.sources.flatMap(source => source.candidates)[0].result.summary!.length, 1_000_000)
    const deep = pagePendingVideoScrapes({ videoId: 9876 })
    assert.equal(deep.offset, 9850); assert.ok(deep.items.some(item => item.videoId === 9876))
    assert.deepEqual(pagePendingVideoScrapes({ anchorId: 9876 }), deep)
    assert.deepEqual(pagePendingVideoScrapes({ offset: 50 }).items.map(item => item.id), Array.from({length:50},(_,i)=>51+i))
    const trace: string[]=[]
    const prepare=db.prepare.bind(db)
    db.prepare=((sql:string)=>{trace.push(sql);return prepare(sql)}) as typeof db.prepare
    const last=pagePendingVideoScrapes({ offset: Number.MAX_SAFE_INTEGER })
    assert.equal(last.offset,9950)
    assert.equal(trace.length,5, 'fixed prepared statement set, no per-item detail hydration')
    assert.ok(trace.every(sql => !/SELECT \*|request_json|warnings_json|selected_fields_json/.test(sql)))
    db.exec('DELETE FROM pending_video_scrapes WHERE id>20')
    assert.equal(pagePendingVideoScrapes({ offset:9950 }).offset,0)
    db.exec('DELETE FROM pending_video_scrapes')
    assert.deepEqual(pagePendingVideoScrapes({ anchorId:9876 }),{items:[],total:0,offset:0})
    for(const query of [{limit:101},{limit:0},{offset:-1},{offset:1.5},{anchorId:0},{videoId:Number.MAX_SAFE_INTEGER+1},{anchorId:1,videoId:1}]) {
      assert.throws(()=>pagePendingVideoScrapes(query),/Invalid/)
    }
  } finally { closeDatabase(); fs.rmSync(directory,{recursive:true,force:true}) }
})
