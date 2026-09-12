import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import type { TagOptionsQuery } from '@shared/commonTypes'
import { CatalogReadWorkerClient, type CatalogReadContext, type CatalogReadCommand, type CatalogReadPage } from './catalogReadWorkerClient'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Transport extends EventEmitter {
  sent: CatalogReadCommand[] = []
  termination = deferred()
  terminations = 0
  postMessage(message: CatalogReadCommand): void { this.sent.push(message) }
  terminate(): Promise<void> { this.terminations++; return this.termination.promise }
  ready(): void { this.emit('message', { type: 'ready' }) }
  result(page: CatalogReadPage = { items: [{ id: 1, label: 'One', video_count: 2 }], hasMore: false }): void {
    this.emit('message', { type: 'result', id: this.sent.at(-1)!.id, result: page })
  }
}
const tick = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
function fixture(timeout = 1000, queueTimeoutMs = 30_000) {
  let context: CatalogReadContext = { identity: {}, path: '/synthetic/library.db', revision: '1' }
  const transports: Transport[] = []
  const client = new CatalogReadWorkerClient({
    contextProvider: () => context,
    transportFactory: () => { const transport = new Transport(); transports.push(transport); return transport },
    startupTimeoutMs: timeout, queryTimeoutMs: timeout, queueTimeoutMs
  })
  return { client, transports, context: () => context,
    change: (patch: Partial<CatalogReadContext>) => { context = { ...context, ...patch } },
    async close() {
      const done = client.dispose()
      for (const transport of transports) transport.termination.resolve()
      await done
      for (const transport of transports) assert.deepEqual(transport.eventNames(), [])
    }
  }
}

it('counts merged subscribers toward capacity, normalizes keys, and clones each successful result', async () => {
  const f = fixture()
  try {
    const reads = Array.from({ length: 32 }, (_, i) => f.client.read(i % 2 ? { search: ' ONE ' } : { search: 'one', limit: 100, offset: 0 }))
    await assert.rejects(f.client.read({ search: 'other' }), /capacity/)
    assert.equal(f.transports.length, 1)
    const worker = f.transports[0]
    assert.equal(worker.sent.length, 0)
    worker.ready()
    assert.equal(worker.sent.length, 1)
    worker.result()
    const pages = await Promise.all(reads)
    pages[0].items[0].label = 'Mutated'
    assert.equal(pages[1].items[0].label, 'One')
    const next = f.client.read({})
    worker.result()
    await next
  } finally { await f.close() }
})

it('serializes different revisions and keeps a folded expanding query valid in the payload', async () => {
  const f = fixture()
  try {
    const first = f.client.read({ search: 'İ'.repeat(500) })
    const worker = f.transports[0]; worker.ready()
    f.change({ revision: '2' })
    const second = f.client.read({ search: 'İ'.repeat(500) })
    assert.equal(worker.sent.length, 1)
    assert.equal((worker.sent[0].query as TagOptionsQuery).search!.length, 500)
    worker.result(); await first
    assert.equal(worker.sent.length, 2)
    worker.result(); await second
  } finally { await f.close() }
})

for (const patch of [{ identity: {} }, { path: '/synthetic/other.db' }]) {
  it(`rejects old generation on ${Object.keys(patch)[0]} change and waits for termination`, async () => {
    const f = fixture()
    try {
      const old = assert.rejects(f.client.read({}), /context changed/)
      const worker = f.transports[0]; worker.ready()
      f.change(patch)
      const next = f.client.read({})
      await old; await tick()
      assert.equal(worker.terminations, 1)
      assert.equal(f.transports.length, 1)
      worker.result(); worker.emit('error', new Error('late')); worker.emit('exit', 0)
      worker.termination.resolve(); await tick()
      assert.equal(f.transports.length, 2)
      assert.deepEqual(worker.eventNames(), [])
      f.transports[1].ready(); f.transports[1].result(); await next
    } finally { await f.close() }
  })
}

it('removes queued aborts but retains an executing slot after all subscribers abort', async () => {
  const f = fixture()
  try {
    const a = new AbortController(), b = new AbortController(), queued = new AbortController()
    const first = assert.rejects(f.client.read({}, a.signal), { name: 'AbortError' })
    const merged = assert.rejects(f.client.read({}, b.signal), { name: 'AbortError' })
    const worker = f.transports[0]; worker.ready()
    const removed = assert.rejects(f.client.read({ offset: 100 }, queued.signal), { name: 'AbortError' })
    queued.abort(); a.abort(); b.abort(); await Promise.all([first, merged, removed])
    const next = f.client.read({ offset: 200 })
    assert.equal(worker.sent.length, 1)
    worker.result()
    assert.equal(worker.sent.length, 2)
    assert.equal((worker.sent[1].query as TagOptionsQuery).offset, 200)
    worker.result(); await next
  } finally { await f.close() }
})

it('one subscriber abort does not cancel another or retain its signal listener', async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    let removed = 0
    const original = controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.removeEventListener = (...args) => { removed++; original(...args) }
    const cancelled = assert.rejects(f.client.read({}, controller.signal), { name: 'AbortError' })
    const survivor = f.client.read({})
    controller.abort(); await cancelled
    f.transports[0].ready(); f.transports[0].result(); await survivor
    assert.equal(removed, 1)
    await assert.rejects(f.client.read({}, controller.signal), { name: 'AbortError' })
  } finally { await f.close() }
})

for (const failure of ['startup timeout', 'query timeout', 'exit', 'error', 'protocol error'] as const) {
  it(`rejects all accepted on ${failure}, without retry or overlapping workers`, async () => {
    const f = fixture(failure.includes('timeout') ? 15 : 1000)
    try {
      const first = assert.rejects(f.client.read({}), /timed out|exit|injected/)
      const second = assert.rejects(f.client.read({ offset: 100 }), /timed out|exit|injected/)
      const worker = f.transports[0]
      if (failure !== 'startup timeout') worker.ready()
      if (failure === 'exit') worker.emit('exit', 0)
      if (failure === 'error') worker.emit('error', new Error('injected'))
      if (failure === 'protocol error') worker.emit('message', { type: 'error', id: worker.sent[0].id, message: 'injected' })
      await Promise.all([first, second]); await tick()
      assert.equal(worker.terminations, 1)
      assert.equal(f.transports.length, 1)
      worker.termination.resolve(); await tick()
      assert.equal(f.transports.length, 1, 'no automatic retry')
    } finally { await f.close() }
  })
}

it('dispose closes admission immediately and waits for a running termination', async () => {
  const f = fixture()
  const read = assert.rejects(f.client.read({}), /disposed/)
  f.transports[0].ready()
  let finished = false
  const done = f.client.dispose().then(() => { finished = true })
  await read; await tick()
  await assert.rejects(f.client.read({}), /disposed/)
  assert.equal(finished, false)
  f.transports[0].termination.resolve(); await done
  await f.client.dispose()
  assert.equal(f.transports[0].terminations, 1)
  assert.deepEqual(f.transports[0].eventNames(), [])
})

it('fails closed if termination rejects and rejects requests waiting for replacement', async () => {
  const f = fixture()
  const old = assert.rejects(f.client.read({}), /context changed/)
  f.change({ identity: {} })
  const waiting = assert.rejects(f.client.read({}), /termination failed/)
  await old
  f.transports[0].termination.reject(new Error('cannot terminate'))
  await waiting; await tick()
  await assert.rejects(f.client.read({}), /termination failed/)
  await assert.rejects(f.client.dispose(), /termination failed/)
  assert.equal(f.transports.length, 1)
  assert.deepEqual(f.transports[0].eventNames(), [])
})

it('rejects invalid queries before creating a worker and contains factory/post failures', async () => {
  const f = fixture()
  for (const query of [{ limit: 101 }, { offset: -1 }, { search: 'x'.repeat(501) }]) {
    await assert.rejects(f.client.read(query), /Invalid/)
  }
  assert.equal(f.transports.length, 0)
  await f.close()
  const client = new CatalogReadWorkerClient({ contextProvider: f.context, transportFactory: () => { throw new Error('factory') } })
  await assert.rejects(client.read({}), /factory/)
  await client.dispose()
  const g = fixture()
  const failed = assert.rejects(g.client.read({}), /post/)
  g.transports[0].postMessage = () => { throw new Error('post') }
  g.transports[0].ready(); await failed
  await g.close()
})

it('bounds subscribers while termination is pending and supersedes a waiting generation', async () => {
  const f = fixture()
  try {
    const old = assert.rejects(f.client.read({}), /context changed/)
    f.change({ identity: {} })
    const waiting = Array.from({ length: 32 }, () => assert.rejects(f.client.read({}), /context changed/))
    await assert.rejects(f.client.read({}), /capacity/)
    assert.equal(f.transports.length, 1)
    f.change({ identity: {} })
    const latest = f.client.read({})
    await old; await Promise.all(waiting)
    f.transports[0].termination.resolve(); await tick()
    assert.equal(f.transports.length, 2)
    f.transports[1].ready(); f.transports[1].result(); await latest
  } finally { await f.close() }
})

it('does not launch work after repeated queued cancellations before ready', async () => {
  const f = fixture()
  try {
    for (let offset = 0; offset < 64; offset++) {
      const controller = new AbortController()
      const cancelled = assert.rejects(f.client.read({ offset }, controller.signal), { name: 'AbortError' })
      controller.abort(); await cancelled
    }
    assert.equal(f.transports.length, 1)
    f.transports[0].ready()
    assert.equal(f.transports[0].sent.length, 0)
    const next = f.client.read({})
    assert.equal(f.transports[0].sent.length, 1)
    f.transports[0].result(); await next
  } finally { await f.close() }
})

it('contains unexpected messages and dispose drains an already-started replacement barrier', async () => {
  const f = fixture()
  const old = assert.rejects(f.client.read({}), /Unexpected/)
  f.transports[0].emit('message', null)
  await old
  const queued = assert.rejects(f.client.read({}), /disposed/)
  const done = f.client.dispose()
  await queued
  f.transports[0].termination.resolve(); await done
  assert.equal(f.transports.length, 1)
  assert.deepEqual(f.transports[0].eventNames(), [])
})


it('expires waiting subscribers and frees capacity while native termination remains pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(1000, 50)
  try {
    const old = assert.rejects(f.client.read({}), /context changed/)
    f.change({ identity: {} })
    const errors: unknown[] = []
    const waiting = Array.from({ length: 32 }, () => f.client.read({}).catch(error => { errors.push(error) }))
    await old
    await assert.rejects(f.client.read({}), /capacity/)
    t.mock.timers.tick(50)
    await Promise.resolve()
    assert.equal(errors.length, 32)
    for (const error of errors) assert.match(String(error), /queue timed out/)
    await Promise.all(waiting)
    assert.equal(f.transports.length, 1, 'expiration must not bypass the native termination barrier')
    const next = f.client.read({})
    f.transports[0].termination.resolve(); await tick()
    assert.equal(f.transports.length, 2)
    f.transports[1].ready(); f.transports[1].result(); await next
  } finally { await f.close() }
})

it('keeps independent waiting deadlines for coalesced subscribers and clears them at execution', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(1000, 50)
  try {
    const active = f.client.read({})
    void active.catch(() => {})
    const worker = f.transports[0]; worker.ready()
    let expired: unknown
    const first = f.client.read({ offset: 100 }).catch(error => { expired = error })
    t.mock.timers.tick(30)
    const survivor = f.client.read({ offset: 100 })
    void survivor.catch(() => {})
    t.mock.timers.tick(20); await Promise.resolve()
    assert.match(String(expired), /queue timed out/)
    await first
    assert.equal(worker.sent.length, 1)
    worker.result(); await active
    assert.equal(worker.sent.length, 2)
    t.mock.timers.tick(60)
    worker.result(); await survivor
    assert.equal(worker.terminations, 0)
  } finally { await f.close() }
})

it('never executes a page whose only subscriber expired before ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(1000, 50)
  try {
    let expired: unknown
    const pending = f.client.read({}).catch(error => { expired = error })
    t.mock.timers.tick(50); await Promise.resolve()
    assert.match(String(expired), /queue timed out/)
    await pending
    f.transports[0].ready()
    assert.equal(f.transports[0].sent.length, 0)
    const next = f.client.read({})
    f.transports[0].result(); await next
  } finally { await f.close() }
})


it('shares admission across tag/image requests, keys entity kinds separately and copies caller inputs', async () => {
  const f=fixture()
  const imagePage={items:[{videoId:1,code:'ONE',title:null,coverPath:'one.jpg'}],total:1,limit:60,offset:0}
  try {
    const entity={kind:'director' as const,id:1},query={offset:0}
    const first=f.client.readImageCandidates(entity,query)
    entity.id=99;query.offset=60
    const duplicate=f.client.readImageCandidates({kind:'director',id:1},{limit:60})
    const tags=f.client.read({limit:60})
    const others=Array.from({length:29},()=>f.client.readImageCandidates({kind:'series',id:1}))
    await assert.rejects(f.client.readImageCandidates({kind:'organization',id:1}),/capacity/)
    const worker=f.transports[0];worker.ready()
    assert.deepEqual(worker.sent[0],{type:'read',id:1,operation:'classification-images',entity:{kind:'director',id:1},query:{limit:60,offset:0}})
    worker.result(imagePage)
    const [a,b]=await Promise.all([first,duplicate]);a.items[0].code='mutated';assert.equal(b.items[0].code,'ONE')
    assert.equal(worker.sent.length,2);assert.equal(worker.sent[1].operation,undefined)
    worker.result();await tags
    assert.equal(worker.sent.length,3);assert.equal(worker.sent[2].operation,'classification-images')
    if(worker.sent[2].operation==='classification-images') assert.equal(worker.sent[2].entity.kind,'series')
    worker.result(imagePage);assert.equal((await Promise.all(others)).length,29)
    assert.equal(f.transports.length,1)
  } finally {await f.close()}
})

it('retains the executing image slot after cancellation and retires it before switching databases',async()=>{
 const f=fixture()
 try{
  const abort=new AbortController()
  const cancelled=assert.rejects(f.client.readImageCandidates({kind:'director',id:1},{},abort.signal),{name:'AbortError'})
  const worker=f.transports[0];worker.ready();abort.abort();await cancelled
  const queued=assert.rejects(f.client.read({}),/context changed/)
  assert.equal(worker.sent.length,1)
  f.change({path:'/synthetic/new.db',identity:{}})
  const next=f.client.readImageCandidates({kind:'director',id:1})
  await queued;await tick();assert.equal(f.transports.length,1)
  worker.result({items:[],total:0,limit:60,offset:0});worker.termination.resolve();await tick()
  assert.equal(f.transports.length,2)
  f.transports[1].ready();f.transports[1].result({items:[],total:0,limit:60,offset:0});assert.equal((await next).total,0)
 } finally {await f.close()}
})

it('validates image requests before allocating a reader',async()=>{
 const f=fixture()
 try{
  for(const id of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(f.client.readImageCandidates({kind:'series',id}),/entity/)
  for(const query of [{limit:101},{limit:0},{offset:-1},{offset:Infinity}])await assert.rejects(f.client.readImageCandidates({kind:'series',id:1},query),/page/)
  assert.equal(f.transports.length,0)
 }finally{await f.close()}
})

it('shares audit admission with tag/image work, coalesces snapshots and copies audit budgets',async()=>{
 const f=fixture(),snapshot={libraryId:1,runId:'audit',finishedAt:'now'},limits={sourceBytes:10000,indexBytes:10000,pageBytes:1000}
 const page={snapshot:{...snapshot},section:'files' as const,items:[{ordinal:0,entry:{outcome:'skipped'}}],total:1,limit:100,offset:0}
 try{
  const first=f.client.readAuditPage(snapshot,{section:'files'},limits)
  snapshot.runId='mutated';limits.pageBytes=1
  const duplicates=Array.from({length:29},()=>f.client.readAuditPage(page.snapshot,{section:'files'},{...limits,pageBytes:1000}))
  const tag=f.client.read({}),image=f.client.readImageCandidates({kind:'director',id:1})
  await assert.rejects(f.client.read({search:'extra'}),/capacity/)
  const worker=f.transports[0];worker.ready();assert.equal(worker.sent.length,1)
  const sent=worker.sent[0];assert.equal(sent.operation,'scan-audit-page')
  if(sent.operation==='scan-audit-page'){assert.equal(sent.snapshot.runId,'audit');assert.equal(sent.limits.pageBytes,1000)}
  worker.result(page);const pages=await Promise.all([first,...duplicates]);pages[0].items[0].entry.outcome='mutated';assert.equal(pages[1].items[0].entry.outcome,'skipped')
  assert.equal(worker.sent.length,2);worker.result();await tag
  worker.result({items:[],total:0,limit:60,offset:0});await image
  assert.equal(worker.sent.length,3);assert.equal(f.transports.length,1)
 }finally{await f.close()}
})
it('rejects invalid audit requests before allocation and removes an aborted queued audit',async()=>{
 const f=fixture(),snapshot={libraryId:1,runId:'audit',finishedAt:'now'},limits={sourceBytes:10000,indexBytes:10000,pageBytes:1000}
 try{
  await assert.rejects(f.client.readAuditHeader(0),/Invalid/)
  await assert.rejects(f.client.readAuditPage({...snapshot,libraryId:0},{section:'files'},limits),/identity/)
  await assert.rejects(f.client.readAuditPage(snapshot,{section:'files',limit:101},limits),/page/)
  await assert.rejects(f.client.readAuditPage(snapshot,{section:'pendingGroups',attention:true},limits),/page/)
  await assert.rejects(f.client.readAuditPage(snapshot,{section:'files'},{...limits,indexBytes:0}),/budget/)
  assert.equal(f.transports.length,0)
  const tag=f.client.read({}),worker=f.transports[0];worker.ready()
  const abort=new AbortController(),audit=assert.rejects(f.client.readAuditPage(snapshot,{section:'files'},limits,abort.signal),{name:'AbortError'})
  abort.abort();await audit;worker.result();await tag;assert.equal(worker.sent.length,1)
 }finally{await f.close()}
})
it('copies view anchors before allocation, coalesces defaults, and shares capacity with raw/header/tag requests',async()=>{
 const f=fixture(),snapshot={libraryId:1,runId:'view',finishedAt:'now'},limits={sourceBytes:10000,indexBytes:10000,pageBytes:1000}
 const anchor={kind:'path' as const,value:'/original'},query={tab:'failed' as const,anchor,locale:'en-US'}
 const page={snapshot:{...snapshot},items:[],total:0,auditAvailable:true,attentionBadgeCount:0,limit:100,offset:0,anchorOffset:null}
 try{
  const first=f.client.readAuditViewPage(snapshot,query,limits)
  anchor.value='/mutated';snapshot.runId='mutated';limits.pageBytes=1
  const copies=Array.from({length:28},()=>f.client.readAuditViewPage(page.snapshot,{tab:'failed',anchor:{kind:'path',value:'/original'},locale:'en-US',outcome:'all',changesFilter:'all',limit:100,offset:0,search:''},{...limits,pageBytes:1000}))
  const raw=f.client.readAuditPage(page.snapshot,{section:'files'},{...limits,pageBytes:1000}),header=f.client.readAuditHeader(1),tag=f.client.read({})
  await assert.rejects(f.client.readAuditViewPage(page.snapshot,{tab:'all'},limits),/capacity/)
  const worker=f.transports[0];worker.ready();assert.equal(worker.sent.length,1)
  const sent=worker.sent[0];assert.equal(sent.operation,'scan-audit-view-page')
  if(sent.operation==='scan-audit-view-page'){assert.deepEqual(sent.query.anchor,{kind:'path',value:'/original'});assert.equal(sent.snapshot.runId,'view');assert.equal(sent.limits.pageBytes,1000)}
  worker.result(page);const pages=await Promise.all([first,...copies]);pages[0].snapshot.runId='changed';assert.equal(pages[1].snapshot.runId,'view')
  worker.result({snapshot:page.snapshot,section:'files',items:[],total:0,limit:100,offset:0});await raw
  worker.result({summary:null,snapshot:null,unrecognizedCount:0});await header
  worker.result();await tag;assert.equal(worker.sent.length,4);assert.equal(f.transports.length,1)
 }finally{await f.close()}
})
it('rejects invalid combined views without a worker and drops canceled queued view requests',async()=>{
 const f=fixture(),snapshot={libraryId:1,runId:'view',finishedAt:'now'},limits={sourceBytes:10000,indexBytes:10000,pageBytes:1000}
 try{
  for(const query of [{tab:'bad'},{tab:'all',locale:'bad_locale'},{tab:'all',search:'x'.repeat(501)},{tab:'all',anchor:{kind:'group',id:1}},{tab:'failed',anchor:{kind:'path',value:''}},{tab:'failed',anchor:{kind:'group',id:0}},{tab:'all',limit:101},{tab:'all',offset:Number.MAX_SAFE_INTEGER+1}]){
   await assert.rejects(f.client.readAuditViewPage(snapshot,query as import('@shared/scanAuditReadTypes').ScanAuditViewQuery,limits))
  }
  assert.equal(f.transports.length,0)
  const tag=f.client.read({}),worker=f.transports[0];worker.ready()
  const abort=new AbortController(),view=assert.rejects(f.client.readAuditViewPage(snapshot,{tab:'all'},limits,abort.signal),{name:'AbortError'})
  abort.abort();await view;worker.result();await tag;assert.equal(worker.sent.length,1)
 }finally{await f.close()}
})
it('shares bounded admission for audit path checks and delivers false without mixing page results',async()=>{
 const f=fixture(),snapshot={libraryId:1,runId:'run',finishedAt:'now'},limits={sourceBytes:10000,indexBytes:10000,pageBytes:1000}
 try{
  for(const [id,filePath] of [[0,'/file'],[1,'relative'],[1,'/bad\0path'],[1,'/'+ 'x'.repeat(32768)]] as const)await assert.rejects(f.client.canRevealAuditPath(id,filePath))
  assert.equal(f.transports.length,0)
  const paths=Array.from({length:30},()=>f.client.canRevealAuditPath(1,'/file.mp4'))
  const tag=f.client.read({}),view=f.client.readAuditViewPage(snapshot,{tab:'all'},limits)
  await assert.rejects(f.client.canRevealAuditPath(1,'/extra.mp4'),/capacity/)
  const worker=f.transports[0];worker.ready();assert.equal(worker.sent[0].operation,'scan-audit-path')
  worker.result(false);assert.ok((await Promise.all(paths)).every(value=>value===false))
  worker.result();await tag
  worker.result({snapshot,auditAvailable:true,items:[],total:0,attentionBadgeCount:0,limit:100,offset:0,anchorOffset:null});await view
  assert.equal(worker.sent.length,3)
  const active=f.client.read({search:'hold'}),abort=new AbortController()
  const canceled=assert.rejects(f.client.canRevealAuditPath(1,'/canceled',abort.signal),{name:'AbortError'})
  abort.abort();await canceled;worker.result();await active;assert.equal(worker.sent.length,4)
 }finally{await f.close()}
})

it('validates catalog commands before worker admission and copies nested desktop filters', async () => {
  const f = fixture()
  try {
    await assert.rejects(f.client.readVideos({ kind: 'library', libraryId: 0 }), /./)
    await assert.rejects(f.client.readHome({ seed: 'x', recentLimit: 1000 }), /./)
    await assert.rejects(f.client.readWebBrowse({ page: 0 }), /筛选/)
    await assert.rejects(f.client.readWebHome(''), /批次/)
    assert.equal(f.transports.length, 0)
    const scope = { kind: 'all' as const, libraryIds: [1] }
    const query = { tagIds: [2], limit: 60 }
    const pending = f.client.readVideos(scope, query)
    scope.libraryIds[0] = 99; query.tagIds[0] = 99
    const worker = f.transports[0]; worker.ready()
    assert.deepEqual(worker.sent[0], { type: 'read', id: 1, operation: 'scoped-video-list', scope: { kind: 'all', libraryIds: [1] }, query: { tagIds: [2], limit: 60 } })
    worker.result({ items: [], total: 0 }); await pending
  } finally { await f.close() }
})

it('shares catalog admission with tags, independently cancels merged subscribers and isolates operations', async () => {
  const f = fixture()
  try {
    const cancel = new AbortController()
    const first = f.client.readWebBrowse({}, cancel.signal)
    const cancelled = assert.rejects(first, { name: 'AbortError' })
    const same = f.client.readWebBrowse({ page: 1, sort: 'recent' })
    const years = f.client.readVideoYears({ kind: 'all' })
    const tags = Array.from({ length: 29 }, () => f.client.read({}))
    await assert.rejects(f.client.readWebCollections(), /capacity/)
    cancel.abort(); await cancelled
    const collections = f.client.readWebCollections()
    const worker = f.transports[0]; worker.ready()
    assert.equal(worker.sent[0].operation, 'web-browse')
    worker.result({ items: [], total: 0, page: 1, pageSize: 36 }); await same
    assert.equal(worker.sent.at(-1)!.operation, 'scoped-video-years')
    worker.result([2025]); assert.deepEqual(await years, [2025])
    worker.result(); await Promise.all(tags)
    worker.result({ libraries: [], playlists: [] }); await collections
    assert.equal(worker.sent.length, 4)
  } finally { await f.close() }
})
