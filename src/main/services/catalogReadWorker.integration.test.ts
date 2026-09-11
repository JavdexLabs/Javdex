import {createMediaLibrary} from '../db/mediaLibraryRepo'
import {buildScanAuditViewItems} from '@shared/scanAuditView'
import { listClassificationImagePage, createClassificationImagePageReader } from './classificationImagePage'
import { openReadOnlyDatabaseAtPath } from '../db/database'
import assert from 'node:assert/strict'
import { after, afterEach, before, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { closeDatabase, getDatabaseReadRevision, initDatabaseAtPath } from '../db/database'
import { listTagFilterOptions } from '../db/tagRepo'
import { insertTestVideoWithFile } from '../db/testVideoFixtures'
import { CatalogReadWorkerClient } from './catalogReadWorkerClient'
import { createCatalogReadWorkerTransport } from './catalogReadWorkerTransport'

let root: string
let bundle: string
let client: CatalogReadWorkerClient | undefined
let sequence = 0
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-catalog-worker-test-'))
  bundle = path.join(root, 'worker.cjs')
  buildSync({ entryPoints: [path.resolve('src/main/services/catalogReadWorker.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', tsconfig: path.resolve('tsconfig.node.json'),
    banner: { js: `require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});` } })
})
afterEach(async () => { await client?.dispose(); client = undefined; closeDatabase() })
after(() => fs.rmSync(root, { recursive: true, force: true }))
function setup() {
  const filename = path.join(root, `catalog-${sequence++}.db`)
  const db = initDatabaseAtPath(filename)
  insertTestVideoWithFile(db, { code: 'WORKER-1', filePath: 'synthetic.mp4', scrapedStatus: 0 })
  db.exec("INSERT INTO tags(id,name) VALUES(1,'École'); INSERT INTO video_tag(video_id,tag_id) VALUES(1,1)")
  client = new CatalogReadWorkerClient({
    contextProvider: () => {
      const revision = getDatabaseReadRevision(db)
      return { identity: db, path: filename, revision: JSON.stringify([revision.changes, revision.dataVersion]) }
    },
    transportFactory: context => createCatalogReadWorkerTransport(bundle, context.path)
  })
  return db
}

it('executes real read-only tag queries and observes writes through the worker cache', async () => {
  const db = setup()
  assert.deepEqual(await client!.read({ search: 'éco' }), listTagFilterOptions({ search: 'éco' }))
  const page = await client!.read({})
  page.items[0].label = 'caller mutation'
  assert.equal((await client!.read({})).items[0].label, 'École')
  db.exec('UPDATE library_video_memberships SET is_hidden=1')
  const pages = await Promise.all([client!.read({}), client!.read({})])
  assert.equal(pages[0].items[0].video_count, 0)
  pages[0].items[0].label = 'subscriber mutation'
  assert.equal(pages[1].items[0].label, 'École')
  await client!.dispose()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM video_tag').get() && db.open, true)
  await assert.rejects(client!.read({}), /disposed/)
})

it('rejects a changed catalog version at worker startup without migration', async () => {
  const db = setup()
  db.pragma('user_version=16')
  await assert.rejects(client!.read({}), /schema|worker|reader/i)
  await client!.dispose()
  assert.equal(db.pragma('user_version', { simple: true }), 16)
  assert.deepEqual(db.prepare('SELECT name FROM tags').all(), [{ name: 'École' }])
})

it('settles in-flight initialization and queued requests when disposed', async () => {
  setup()
  const first = client!.read({})
  const second = client!.read({ search: 'other' })
  const rejected = Promise.all([assert.rejects(first, /disposed/), assert.rejects(second, /disposed/)])
  await client!.dispose()
  await rejected
})


it('executes all classification cover pages on the readonly worker and observes committed writes',async()=>{
 const db=setup()
 db.exec("INSERT INTO organizations(id,main_name) VALUES(1,'Org');INSERT INTO directors(id,main_name) VALUES(1,'Director');INSERT INTO series(id,main_name) VALUES(1,'Series')")
 const insert=db.prepare('INSERT INTO videos(code,title,cover_path,release_date,maker_organization_id,publisher_organization_id,director_id,series_id) VALUES(?,?,?,?,1,1,1,1)')
 for(let n=0;n<125;n++)insert.run(`COVER-${n}`,`Title-${n}`,n%7===0?' ':`cover-${n}.jpg`,n%2?'2026-01-01':null)
 for(const kind of ['organization','director','series'] as const)for(const offset of [0,60,120]){
   const entity={kind,id:1},expected=listClassificationImagePage(entity,{offset})
   assert.deepEqual(await client!.readImageCandidates(entity,{offset}),expected)
 }
 db.exec("UPDATE videos SET cover_path=NULL WHERE code='COVER-1'")
 const pages=await Promise.all([client!.readImageCandidates({kind:'director',id:1}),client!.readImageCandidates({kind:'director',id:1})])
 assert.deepEqual(pages[0],listClassificationImagePage({kind:'director',id:1}))
 pages[0].items[0].code='mutated';assert.notEqual(pages[1].items[0].code,'mutated')
 assert.deepEqual(await client!.read({}),listTagFilterOptions({}))
 const readonly=openReadOnlyDatabaseAtPath(db.name)
 try{assert.deepEqual(createClassificationImagePageReader(()=>readonly)({kind:'series',id:1}),listClassificationImagePage({kind:'series',id:1}));assert.throws(()=>readonly.exec('DELETE FROM videos'),/readonly|read-only/i)}finally{readonly.close()}
})

it('rejects image initialization against an incompatible schema without rewriting it',async()=>{
 const db=setup();db.pragma('user_version=16')
 await assert.rejects(client!.readImageCandidates({kind:'director',id:1}),/schema|worker|reader/i)
 await client!.dispose();assert.equal(db.pragma('user_version',{simple:true}),16)
})

it('reads bounded audit pages in the real worker, isolates operations and observes audit replacement',async()=>{
 const db=setup(),snapshot={libraryId:1,runId:'audit-worker',finishedAt:'2026-09-11T00:00:00Z'}
 const limits={sourceBytes:8*1024*1024,indexBytes:16*1024*1024,pageBytes:64*1024}
 const files=Array.from({length:325},(_,i)=>({rootId:1,filePath:`/audit/${i}.mp4`,sourceKind:'local',outcome:i%2?'skipped':'unrecognized',skipReason:'unchanged'}))
 const audit={...snapshot,schemaVersion:2,files,removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,1,1,'manual','completed','2026-09-11',?)").run(snapshot.runId,JSON.stringify(audit))
 for(const offset of [0,100,200,300]){
  const page=await client!.readAuditPage(snapshot,{section:'files',offset},limits)
  assert.equal(page.total,325);assert.deepEqual(page.items.map(item=>item.entry),files.slice(offset,offset+100))
 }
 const [one,two,tags]=await Promise.all([client!.readAuditPage(snapshot,{section:'files'},limits),client!.readAuditPage(snapshot,{section:'files'},limits),client!.read({})])
 one.items[0].entry.filePath='mutated';assert.equal(two.items[0].entry.filePath,files[0].filePath);assert.deepEqual(tags,listTagFilterOptions({}))
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify({...audit,files:[]}),snapshot.runId)
 assert.equal((await client!.readAuditPage(snapshot,{section:'files'},limits)).total,0)
 await assert.rejects(client!.readAuditPage({...snapshot,finishedAt:'mismatch'},{section:'files'},limits),/identity|structure/)
 assert.equal((await client!.readAuditPage(snapshot,{section:'files'},limits)).total,0)
 await client!.dispose();assert.equal(db.open,true)
})

it('reads audit headers on the real worker without building an index from the audit body',async()=>{
 const db=setup(),summary={libraryId:1,runId:'header',status:'success',finishedAt:'now'}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES('header',1,1,'manual','completed','now',?)").run('invalid audit JSON')
 db.prepare('INSERT OR REPLACE INTO media_library_scan_state(library_id,last_summary_json) VALUES(1,?)').run(JSON.stringify(summary))
 assert.deepEqual(await client!.readAuditHeader(1),{summary,snapshot:{libraryId:1,runId:'header',finishedAt:'now'},unrecognizedCount:0})
 const [one,two]=await Promise.all([client!.readAuditHeader(1),client!.readAuditHeader(1)])
 one.snapshot!.runId='mutated';assert.equal(two.snapshot!.runId,'header')
 await assert.rejects(client!.readAuditHeader(0),/Invalid/)
 assert.deepEqual(await client!.read({}),listTagFilterOptions({}))
})

it('reads combined views in the real worker, upgrades raw pages and rebuilds after writes and failures',async()=>{
 const db=setup(),snapshot={libraryId:1,runId:'view-worker',finishedAt:'2026-09-11T00:00:00Z'}
 const limits={sourceBytes:1024*1024,indexBytes:4*1024*1024,pageBytes:64*1024}
 const audit:import('@shared/libraryTypes').LibraryScanAudit={...snapshot,schemaVersion:2,configRevision:1,trigger:'manual',status:'success',startedAt:'before',
  files:Array.from({length:325},(_,i)=>({rootId:1,filePath:`/audit/${i}.mp4`,sourceKind:'local',outcome:i%2?'skipped':'unrecognized',skipReason:'unchanged'})),
  removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[{groupId:9,normalizedCode:'PENDING',resourceCount:2}]}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,1,1,'manual','completed','before',?)").run(snapshot.runId,JSON.stringify(audit))
 const expected=buildScanAuditViewItems({audit,unrecognized:[],activeTab:'failed',outcome:'all',changesFilter:'all'})
 assert.equal((await client!.readAuditPage(snapshot,{section:'files'},limits)).total,325)
 const all=[]
 for(let offset=0;offset<expected.length;offset+=100){
  const page=await client!.readAuditViewPage(snapshot,{tab:'failed',offset},limits)
  assert.equal(page.total,expected.length);all.push(...page.items)
 }
 assert.deepEqual(all,expected)
 const anchor=await client!.readAuditViewPage(snapshot,{tab:'failed',anchor:{kind:'group',id:9}},limits)
 assert.equal(anchor.anchorOffset,100);assert.equal(anchor.items.at(-1)?.groupId,9)
 const [one,two,raw,tags]=await Promise.all([client!.readAuditViewPage(snapshot,{tab:'all',search:'/audit/3'},limits),client!.readAuditViewPage(snapshot,{tab:'all',search:'/audit/3'},limits),client!.readAuditPage(snapshot,{section:'files'},limits),client!.read({})])
 assert.ok(one.total>0);one.items[0].title='mutated';assert.notEqual(two.items[0].title,'mutated');assert.equal(raw.total,325);assert.equal(tags.items[0].label,'École')
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify({...audit,files:[],pendingGroups:[]}),snapshot.runId)
 assert.equal((await client!.readAuditViewPage(snapshot,{tab:'failed'},limits)).total,0)
 await assert.rejects(client!.readAuditViewPage({...snapshot,finishedAt:'wrong'},{tab:'all'},limits),/identity|structure/)
 assert.equal((await client!.readAuditViewPage(snapshot,{tab:'all'},limits)).total,0)
 assert.equal(db.pragma('query_only',{simple:true}),0)
})
it('keeps missing-body pending pages available and rejects a superseded summary on the real worker',async()=>{
 const db=setup(),directory=path.join(root,'missing-audit-media');fs.mkdirSync(directory)
 const library=createMediaLibrary({name:'Missing audit',roots:[{path:directory}]})
 const snapshot={libraryId:library.id,runId:'missing-body',finishedAt:'now'},summary={...snapshot,status:'success'}
 const limits={sourceBytes:1024*1024,indexBytes:4*1024*1024,pageBytes:64*1024}
 db.prepare('INSERT OR REPLACE INTO media_library_scan_state(library_id,last_summary_json) VALUES(?,?)').run(library.id,JSON.stringify(summary))
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at) VALUES(?,?,1,'manual','completed','now')").run(snapshot.runId,library.id)
 const insert=db.prepare('INSERT INTO library_unrecognized_files(library_id,root_id,file_path,normalized_path,scan_run_id,last_seen_at) VALUES(?,?,?,?,?,?)')
 db.transaction(()=>{for(let i=0;i<205;i++)insert.run(library.id,library.roots[0].id,path.join(directory,`${i}.mp4`),String(i).padStart(5,'0'),snapshot.runId,'now')})()
 const header=await client!.readAuditHeader(library.id)
 assert.equal(header.snapshot,null);assert.equal(header.unrecognizedCount,205)
 const first=await client!.readAuditViewPage(snapshot,{tab:'failed'},limits),last=await client!.readAuditViewPage(snapshot,{tab:'failed',offset:200},limits)
 assert.equal(first.auditAvailable,false);assert.equal(first.items.length,100);assert.equal(last.items.length,5);assert.equal(last.total,205)
 assert.equal(last.items[4].path,path.join(directory,'204.mp4'))
 const next={...snapshot,runId:'next'}
 db.transaction(()=>{
  db.prepare('UPDATE media_library_scan_state SET last_summary_json=? WHERE library_id=?').run(JSON.stringify({...next,status:'success'}),library.id)
  db.prepare('DELETE FROM library_unrecognized_files WHERE library_id=?').run(library.id)
 })()
 await assert.rejects(client!.readAuditViewPage(snapshot,{tab:'failed'},limits),/summary changed/)
 assert.equal((await client!.readAuditViewPage(next,{tab:'failed'},limits)).total,0)
 await assert.rejects(client!.readAuditPage(next,{section:'files'},limits),/unavailable/)
 const audit={...next,schemaVersion:2,files:[{rootId:library.roots[0].id,filePath:'/new.mp4',sourceKind:'local',outcome:'skipped',skipReason:'unchanged'}],removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,?,1,'manual','completed','now',?)").run(next.runId,library.id,JSON.stringify(audit))
 const restored=await client!.readAuditViewPage(next,{tab:'all'},limits)
 assert.equal(restored.auditAvailable,true);assert.equal(restored.total,1);assert.equal(restored.items[0].path,'/new.mp4')
})
it('checks latest audit paths on the real worker and rejects invalid later entries after a match',async()=>{
 const db=setup(),snapshot={libraryId:1,runId:'path-run',finishedAt:'now'}
 const audit={...snapshot,schemaVersion:2,configRevision:1,trigger:'manual',status:'success',startedAt:'before',files:[{rootId:1,filePath:'/Audit/One.mp4',sourceKind:'local',outcome:'skipped',skipReason:'unchanged'}],removedResources:[],promotedResources:[],deletedVideos:[],pendingGroups:[]}
 db.prepare("INSERT INTO library_scan_runs(id,library_id,config_revision,trigger,status,started_at,audit_json) VALUES(?,1,1,'manual','completed','before',?)").run(snapshot.runId,JSON.stringify(audit))
 const [allowed,missing,tags]=await Promise.all([client!.canRevealAuditPath(1,'/audit/one.mp4'),client!.canRevealAuditPath(1,'/no.mp4'),client!.read({})])
 assert.equal(allowed,true);assert.equal(missing,false);assert.equal(tags.items[0].label,'École')
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify({...audit,files:[...audit.files,{...audit.files[0],rootId:0}]}),snapshot.runId)
 assert.equal(await client!.canRevealAuditPath(1,'/audit/one.mp4'),false)
 db.prepare('UPDATE library_scan_runs SET audit_json=? WHERE id=?').run(JSON.stringify(audit),snapshot.runId)
 assert.equal(await client!.canRevealAuditPath(1,'/audit/one.mp4'),true)
 assert.equal(db.pragma('query_only',{simple:true}),0)
})
