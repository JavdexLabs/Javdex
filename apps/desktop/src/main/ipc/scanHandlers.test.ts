import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'
import type { AppIpcContract } from '@shared/appIpcContract'
import { IPC, type IpcChannel } from '@shared/ipc-channels'
import type { LibraryScanLatestSnapshot } from '@shared/libraryTypes'
import { appIpcSchemas } from './ipcCommandSchemas'
import { registerScanLatestHandler, registerScanAuditReadHandlers, registerScanAuditRevealHandler, runScanThroughBackend, importManualThroughBackend, renameThroughBackend, resolvePendingScanThroughBackend, resolveResourceIdentityThroughBackend, auditGetThroughBackend, auditPageThroughBackend, auditViewPageThroughBackend, getPendingScanThroughBackend, listPendingScansThroughBackend, pagePendingScanQueueThroughBackend, countPendingScanQueueThroughBackend, pendingAuditPresenceThroughBackend } from './scanHandlers'
import type { CatalogBackend } from '../application/catalogBackend'
import { isStructuredError } from '@shared/protocol/errors'
import { SCAN_AUDIT_READ_LIMITS } from '../services/scanAuditReadPolicy'
import { createTypedIpcAdapter } from './typedIpcAdapter'

describe('scan latest IPC handler', () => {
  it('validates libraryId and forwards the scoped latest snapshot', async () => {
    const registrations = new Map<
      IpcChannel,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
    >()
    const adapter = createTypedIpcAdapter<AppIpcContract>(
      appIpcSchemas,
      (channel, handler) => registrations.set(channel, handler)
    )
    const expected: LibraryScanLatestSnapshot = {
      summary: null,
      audit: null,
      unrecognized: [{ rootId: 8, filePath: '/media/UNKNOWN.mp4' }]
    }
    const calls: number[] = []
    registerScanLatestHandler(adapter, (libraryId) => {
      calls.push(libraryId)
      return expected
    })
    const handler = registrations.get(IPC.SCAN_LATEST_GET)
    assert.ok(handler)

    assert.deepEqual(await handler({} as IpcMainInvokeEvent, 3), expected)
    assert.deepEqual(calls, [3])
    assert.throws(() => handler({} as IpcMainInvokeEvent, 0), /无效的 IPC 请求参数/)
  })
})

it('bounds the combined audit presence request and validates its library',()=>{
 const schema=appIpcSchemas[IPC.PENDING_AUDIT_PRESENCE]
 assert.equal(schema.safeParse([1,{groupIds:[1],identityIds:[2],scrapeIds:[3]}]).success,true)
 for(const args of [[0,{groupIds:[],identityIds:[],scrapeIds:[]}],[1,{groupIds:Array(51).fill(1),identityIds:Array(50).fill(1),scrapeIds:[]}],[1,{groupIds:[Number.MAX_SAFE_INTEGER+1],identityIds:[],scrapeIds:[]}],[1,{groupIds:[],identityIds:[],scrapeIds:[],sql:'anything'}]])assert.equal(schema.safeParse(args).success,false)
})

it('bounds scan pages and validates scoped detail and anchor inputs',()=>{
 const page=appIpcSchemas[IPC.PENDING_SCAN_QUEUE_PAGE]
 assert.equal(page.safeParse([{limit:100,offset:0,libraryId:1,anchor:{kind:'identity',id:2}}]).success,true)
 for(const query of [{limit:101},{offset:-1},{libraryId:0},{anchor:{kind:'bad',id:1}},{anchor:{kind:'group',id:Number.MAX_SAFE_INTEGER+1}},{sql:'SELECT *'}])assert.equal(page.safeParse([query]).success,false)
 for(const channel of [IPC.PENDING_SCAN_GET,IPC.PENDING_RESOURCE_IDENTITY_GET]){
  assert.equal(appIpcSchemas[channel].safeParse([1,2]).success,true)
  assert.equal(appIpcSchemas[channel].safeParse([0,2]).success,false)
  assert.equal(appIpcSchemas[channel].safeParse([1,-1]).success,false)
 }
 assert.equal(appIpcSchemas[IPC.PENDING_SCAN_QUEUE_COUNT].safeParse([undefined]).success,true)
 assert.equal(appIpcSchemas[IPC.PENDING_SCAN_QUEUE_COUNT].safeParse([0]).success,false)
})

it('routes audit header/page through the async reader with trusted budgets and strict scope',async()=>{
 const handlers=new Map<IpcChannel,(event:IpcMainInvokeEvent,...args:unknown[])=>unknown>()
 const adapter=createTypedIpcAdapter<AppIpcContract>(appIpcSchemas,(channel,handler)=>handlers.set(channel,handler))
 const calls:unknown[]=[]
 registerScanAuditReadHandlers(adapter,{
  readAuditViewPage:async()=>{throw new Error('Unexpected view read')},
  readAuditHeader:async libraryId=>{calls.push(['header',libraryId]);return{summary:null,snapshot:null,unrecognizedCount:0}},
  readAuditPage:async(snapshot,query,limits)=>{calls.push(['page',snapshot,query,limits]);return{snapshot,section:query.section,items:[],total:0,limit:100,offset:0}}
 })
 const snapshot={libraryId:1,runId:'one',finishedAt:'now'},event={} as IpcMainInvokeEvent
 await handlers.get(IPC.SCAN_AUDIT_HEADER)!(event,1)
 await handlers.get(IPC.SCAN_AUDIT_PAGE)!(event,snapshot,{section:'files',attention:true})
 assert.deepEqual(calls,[['header',1],['page',snapshot,{section:'files',attention:true},SCAN_AUDIT_READ_LIMITS]])
 for(const args of [[{...snapshot,libraryId:0},{section:'files'}],[snapshot,{section:'files',limit:101}],[snapshot,{section:'files',offset:-1}],[snapshot,{section:'files',limits:{sourceBytes:1e12}}],[snapshot,{section:'files'},SCAN_AUDIT_READ_LIMITS],[snapshot,{section:'pendingGroups',attention:true}],[{...snapshot,runId:'x'.repeat(257)},{section:'files'}]]){
  assert.throws(()=>handlers.get(IPC.SCAN_AUDIT_PAGE)!(event,...args),/无效的 IPC/)
 }
 assert.throws(()=>handlers.get(IPC.SCAN_AUDIT_HEADER)!(event,Number.MAX_SAFE_INTEGER+1),/无效的 IPC/)
 assert.equal(calls.length,2)
})

it('routes combined view pages with trusted budgets and preserves query and result fields', async () => {
  const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) => handlers.set(channel, handler))
  const snapshot = { libraryId: 3, runId: 'view-run', finishedAt: '2026-09-11T12:00:00Z' }
  const query = { tab: 'failed' as const, outcome: 'all' as const, changesFilter: 'all' as const,
    search: '空 格', locale: 'zh-hans-cn', limit: 100, offset: 200,
    anchor: { kind: 'path' as const, value: 'C:\\library\\name.mp4' } }
  const expected = { snapshot, items: [{ key: 'file:7:path', title: '原文', detail: '待处理',
    pendingTarget: { domain: 'scan' as const, id: 'identity-73' } }],
    auditAvailable: true, total: 235, attentionBadgeCount: 18, limit: 100, offset: 200, anchorOffset: 100 }
  const calls: unknown[] = []
  registerScanAuditReadHandlers(adapter, {
    readAuditHeader: async () => { throw Error('Unexpected header read') },
    readAuditPage: async () => { throw Error('Unexpected raw page read') },
    readAuditViewPage: async (actualSnapshot, actualQuery, limits) => {
      assert.strictEqual(limits, SCAN_AUDIT_READ_LIMITS)
      calls.push([actualSnapshot, actualQuery])
      return expected
    }
  })
  const handler = handlers.get(IPC.SCAN_AUDIT_VIEW_PAGE)!
  assert.strictEqual(await handler({} as IpcMainInvokeEvent, snapshot, query), expected)
  assert.deepEqual(calls, [[snapshot, query]])
  for (const args of [
    [snapshot, { ...query, limits: { pageBytes: 1e12 } }],
    [snapshot, query, SCAN_AUDIT_READ_LIMITS],
    [{ ...snapshot, budget: 1e12 }, query],
    [snapshot, { ...query, locale: 'en_US' }],
    [snapshot, { ...query, tab: 'all' }]
  ]) assert.throws(() => handler({} as IpcMainInvokeEvent, ...args), /无效的 IPC/)
  assert.equal(calls.length, 1, 'invalid requests must never reach the reader')
})

it('accepts every combined tab/outcome/filter, canonicalizable locales and strict failed anchors', () => {
  const schema = appIpcSchemas[IPC.SCAN_AUDIT_VIEW_PAGE]
  const snapshot = { libraryId: Number.MAX_SAFE_INTEGER, runId: 'r'.repeat(256), finishedAt: 't'.repeat(100) }
  for (const tab of ['failed', 'all', 'added_updated', 'skipped', 'changes']) {
    assert.equal(schema.safeParse([snapshot, { tab }]).success, true)
    for (const outcome of ['all', 'added', 'updated', 'pending', 'skipped', 'unrecognized', 'strm_failure', 'processing_failure']) {
      for (const changesFilter of ['all', 'removed', 'promoted', 'deleted']) {
        assert.equal(schema.safeParse([snapshot, { tab, outcome, changesFilter, search: '', limit: 1, offset: 0 }]).success, true)
      }
    }
  }
  for (const locale of ['en', 'en-us', 'zh-Hans-CN', 'tr-TR', 'de-DE-u-co-phonebk']) {
    const query = { tab: 'all', locale, search: 'x'.repeat(500), limit: 100, offset: Number.MAX_SAFE_INTEGER }
    const parsed = schema.safeParse([snapshot, query])
    assert.equal(parsed.success, true, locale)
    if (parsed.success) assert.deepEqual(parsed.data, [snapshot, query], 'validation must not transform locale or search')
  }
  for (const anchor of [
    { kind: 'path', value: 'x'.repeat(32768) }, { kind: 'path', value: 'C:\\exact\\Case.mp4' },
    { kind: 'group', id: 1 }, { kind: 'group', id: Number.MAX_SAFE_INTEGER }
  ]) assert.equal(schema.safeParse([snapshot, { tab: 'failed', anchor }]).success, true)
})

it('rejects invalid combined queries, locales, anchors, snapshots and argument counts', () => {
  const schema = appIpcSchemas[IPC.SCAN_AUDIT_VIEW_PAGE]
  const snapshot = { libraryId: 1, runId: 'r', finishedAt: 't' }
  const badQueries: unknown[] = [
    undefined, null, [], {}, { tab: 'unknown' }, { tab: 'all', outcome: 'bad' },
    { tab: 'changes', changesFilter: 'bad' }, { tab: 'all', search: 'x'.repeat(501) },
    { tab: 'all', search: 1 }, { tab: 'all', locale: '' }, { tab: 'all', locale: ' ' },
    { tab: 'all', locale: 'x'.repeat(101) }, { tab: 'all', locale: 'en_US' },
    { tab: 'all', locale: 'en--US' }, { tab: 'all', locale: 'i' },
    { tab: 'all', locale: ['en'] }, { tab: 'all', locale: null },
    ...[0, -1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '60', null].map(limit => ({ tab: 'all', limit })),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null].map(offset => ({ tab: 'all', offset })),
    ...[{}, null, { kind: 'path', value: '' }, { kind: 'path', value: 'x'.repeat(32769) },
      { kind: 'path', value: '/x', id: 1 }, { kind: 'path', value: 1 },
      { kind: 'group', id: 1, value: '/x' }, { kind: 'identity', id: 1 },
      ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null].map(id => ({ kind: 'group', id }))
    ].map(anchor => ({ tab: 'failed', anchor })),
    ...['all', 'added_updated', 'skipped', 'changes'].flatMap(tab => [
      { tab, anchor: { kind: 'path', value: '/x' } }, { tab, anchor: { kind: 'group', id: 1 } }
    ]),
    ...['limits', 'sourceBytes', 'indexBytes', 'pageBytes', 'sql', 'section', 'attention'].map(key => ({ tab: 'all', [key]: 1 }))
  ]
  for (const query of badQueries) assert.equal(schema.safeParse([snapshot, query]).success, false, JSON.stringify(query))
  for (const badSnapshot of [
    null, {}, { ...snapshot, extra: true }, { ...snapshot, libraryId: 0 },
    { ...snapshot, libraryId: Number.MAX_SAFE_INTEGER + 1 }, { ...snapshot, runId: '' },
    { ...snapshot, runId: 'x'.repeat(257) }, { ...snapshot, finishedAt: '' },
    { ...snapshot, finishedAt: 'x'.repeat(101) }
  ]) assert.equal(schema.safeParse([badSnapshot, { tab: 'all' }]).success, false)
  for (const args of [[], [snapshot], [snapshot, { tab: 'all' }, undefined],
    [snapshot, { tab: 'all' }, SCAN_AUDIT_READ_LIMITS]]) {
    assert.equal(schema.safeParse(args).success, false)
  }
})

it('propagates combined reader errors instead of falling back to another snapshot or raw page', async () => {
  const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) => handlers.set(channel, handler))
  const error = new Error('snapshot expired')
  registerScanAuditReadHandlers(adapter, {
    readAuditHeader: async () => { throw Error('Unexpected header read') },
    readAuditPage: async () => { throw Error('Unexpected raw page read') },
    readAuditViewPage: async () => { throw error }
  })
  await assert.rejects(async () => handlers.get(IPC.SCAN_AUDIT_VIEW_PAGE)!({} as IpcMainInvokeEvent,
    { libraryId: 1, runId: 'old', finishedAt: 'old' }, { tab: 'all' }), error)
})

function revealHandler(dependencies: {
  permission: (libraryId: number, filePath: string) => Promise<boolean>
  access: (filePath: string) => Promise<void>
  reveal: (filePath: string) => void
}) {
  const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) => handlers.set(channel, handler))
  registerScanAuditRevealHandler(adapter, { canRevealAuditPath: dependencies.permission }, dependencies.access, dependencies.reveal)
  const handler = handlers.get(IPC.SCAN_AUDIT_REVEAL_FILE)
  assert.ok(handler, 'register the actual reveal IPC channel')
  return (...args: unknown[]) => handler({} as IpcMainInvokeEvent, ...args)
}

it('rejects invalid reveal paths before permission lookup and retains strict IPC arguments', async () => {
  const calls: unknown[] = []
  const handler = revealHandler({
    permission: async (...args) => { calls.push(args); return true },
    access: async path => { calls.push(['access', path]) },
    reveal: path => { calls.push(['reveal', path]) }
  })
  for (const path of ['relative.mp4', '   ', '/media/invalid\0.mp4', 'https://example.test/video']) {
    assert.deepEqual(await handler(1, path), { ok: false, error: '路径不属于该媒体库最近一次扫描审计' })
  }
  for (const args of [[], [1], [1, ''], [1, 12], [0, '/media/file.mp4'],
    [1, '/media/file.mp4', true], [1, '/media/file.mp4', undefined],
    [1, '/media/file.mp4', { allowed: true }]]) {
    assert.throws(() => handler(...args), /无效的 IPC/)
  }
  assert.deepEqual(calls, [])
})

it('does not access or reveal an unauthorized audit path', async () => {
  const calls: unknown[] = []
  const handler = revealHandler({
    permission: async (libraryId, path) => { calls.push(['permission', libraryId, path]); return false },
    access: async path => { calls.push(['access', path]) },
    reveal: path => { calls.push(['reveal', path]) }
  })
  assert.deepEqual(await handler(7, '/media/other.mp4'), { ok: false, error: '路径不属于该媒体库最近一次扫描审计' })
  assert.deepEqual(calls, [['permission', 7, '/media/other.mp4']])
})

it('returns a handled verification error when the permission reader rejects', async () => {
  const calls: string[] = []
  const handler = revealHandler({
    permission: async () => { calls.push('permission'); throw Error('private worker failure') },
    access: async () => { calls.push('access') },
    reveal: () => { calls.push('reveal') }
  })
  assert.deepEqual(await handler(1, '/media/file.mp4'), { ok: false, error: '无法验证路径是否属于该媒体库最近一次扫描审计' })
  assert.deepEqual(calls, ['permission'])
})

it('awaits permission and asynchronous access before revealing the original path exactly once', async () => {
  let allow!: (value: boolean) => void
  let accessible!: () => void
  const permission = new Promise<boolean>(resolve => { allow = resolve })
  const access = new Promise<void>(resolve => { accessible = resolve })
  const calls: unknown[] = []
  const originalPath = '/media/../media/Upper Case.mp4'
  const handler = revealHandler({
    permission: (libraryId, path) => { calls.push(['permission', libraryId, path]); return permission },
    access: path => { calls.push(['access', path]); return access },
    reveal: path => { calls.push(['reveal', path]) }
  })
  let completed = false
  const result = Promise.resolve(handler(3, originalPath)).then(value => { completed = true; return value })
  assert.deepEqual(calls, [['permission', 3, originalPath]])
  assert.equal(completed, false)
  allow(true)
  await Promise.resolve()
  assert.deepEqual(calls, [['permission', 3, originalPath], ['access', originalPath]])
  assert.equal(completed, false)
  accessible()
  assert.deepEqual(await result, { ok: true })
  assert.deepEqual(calls, [['permission', 3, originalPath], ['access', originalPath], ['reveal', originalPath]])
})

it('returns fileMissing on asynchronous access failure without revealing', async () => {
  for (const code of ['ENOENT', 'EACCES']) {
    const calls: string[] = []
    const handler = revealHandler({
      permission: async () => { calls.push('permission'); return true },
      access: async () => { calls.push('access'); throw Object.assign(Error(code), { code }) },
      reveal: () => { calls.push('reveal') }
    })
    assert.deepEqual(await handler(1, '/media/missing.mp4'), { ok: false, fileMissing: true })
    assert.deepEqual(calls, ['permission', 'access'])
  }
})

it('runs SCAN_RUN through the catalog backend instead of the local coordinator singleton', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    libraries: {
      runScan: async (input: { libraryId: number }) => {
        calls.push(['runScan', input])
        return { taskId: '11111111-1111-1111-1111-111111111111', receipt: { operationId: 'op' } }
      }
    },
    tasks: {
      get: async (input: { taskId: string }) => {
        calls.push(['tasks.get', input])
        return {
          owner: 'catalog',
          taskId: input.taskId,
          catalogId: 'catalog',
          kind: 'scan',
          state: 'succeeded',
          taskRevision: 2,
          progressSeq: 1,
          counts: { scanned: 4, imported: 1 }
        }
      }
    }
  } as unknown as CatalogBackend
  const result = await runScanThroughBackend(backend, 3)
  assert.equal(result.libraryId, 3)
  assert.equal(result.scannedFiles, 4)
  assert.equal(result.imported, 1)
  assert.deepEqual(calls[0], ['runScan', { libraryId: 3 }])
  assert.equal((calls[1] as [string, { taskId: string }])[0], 'tasks.get')
})

it('runs FILE_IMPORT_MANUAL through the catalog backend with a root-relative location', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    generation: 1,
    libraries: {
      importManual: async (input: unknown, ctx: unknown) => {
        calls.push(['importManual', input, ctx])
        return { imported: true, code: 'D02-001' }
      }
    }
  } as unknown as CatalogBackend
  const result = await importManualThroughBackend(
    backend,
    3,
    8,
    'clip.mp4',
    'D02-001',
    { kind: 'new' }
  )
  assert.equal(result.imported, true)
  assert.equal((calls[0] as [string, { location: { relativePath: string } }])[0], 'importManual')
  assert.equal(
    ((calls[0] as [string, { location: { relativePath: string } }])[1]).location.relativePath,
    'clip.mp4'
  )
  await assert.rejects(
    () =>
      importManualThroughBackend(backend, 3, 8, '/abs/clip.mp4', 'D02-001', { kind: 'new' }),
    (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
  )
})

it('refuses remote FILE_RENAME until the IPC carries a resource id', async () => {
  const backend = { mode: 'remote', generation: 1, libraries: {} } as unknown as CatalogBackend
  await assert.rejects(
    () => renameThroughBackend(backend, 3, 8, 'clip.mp4', 'renamed.mp4'),
    (error: unknown) => isStructuredError(error) && error.code === 'UNSUPPORTED_CAPABILITY'
  )
})

it('routes PENDING_SCAN_RESOLVE through the catalog backend with Q/V/R/G', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    generation: 4,
    libraries: {
      resolvePendingScan: async (input: unknown, ctx: unknown) => {
        calls.push(['resolvePendingScan', input, ctx])
        return { createdVideoIds: [11] }
      }
    }
  } as unknown as CatalogBackend
  const resolution = {
    expectedRevision: 7,
    assignments: [{ resourceId: 3, target: { kind: 'new' as const, groupKey: 'ABC-001' } }]
  }
  const result = await resolvePendingScanThroughBackend(backend, 1, 9, resolution)
  assert.deepEqual(result, { createdVideoIds: [11] })
  const [, input, ctx] = calls[0] as [
    string,
    { libraryId: number; groupId: number; expectedRevision: number },
    { expectedVersions: { Q: { generation: number; revision: number } } }
  ]
  assert.equal(input.libraryId, 1)
  assert.equal(input.groupId, 9)
  assert.equal(input.expectedRevision, 7)
  assert.deepEqual(ctx.expectedVersions.Q, { generation: 4, revision: 7 })
})

it('routes PENDING_RESOURCE_IDENTITY_RESOLVE through the catalog backend', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    generation: 2,
    libraries: {
      resolveResourceIdentity: async (input: unknown, ctx: unknown) => {
        calls.push(['resolveResourceIdentity', input, ctx])
        return { applied: true }
      }
    }
  } as unknown as CatalogBackend
  const result = await resolveResourceIdentityThroughBackend(backend, 1, 5, {
    expectedRevision: 3,
    choice: 'nfo'
  })
  assert.deepEqual(result, { applied: true })
  const [, input, ctx] = calls[0] as [
    string,
    { identityId: number; choice: string },
    { expectedVersions: { Q: { revision: number } } }
  ]
  assert.equal(input.identityId, 5)
  assert.equal(input.choice, 'nfo')
  assert.equal(ctx.expectedVersions.Q.revision, 3)
})

it('routes SCAN_AUDIT_GET through the catalog backend', async () => {
  const calls: unknown[] = []
  const backend = {
    libraries: {
      auditGet: async (input: { libraryId: number }) => {
        calls.push(input)
        return { summary: null }
      }
    }
  } as unknown as CatalogBackend
  assert.deepEqual(await auditGetThroughBackend(backend, 3), { summary: null })
  assert.deepEqual(calls, [{ libraryId: 3 }])
})

it('routes remote SCAN_AUDIT_PAGE and VIEW_PAGE through the catalog backend', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    libraries: {
      auditPage: async (input: unknown) => {
        calls.push(['page', input])
        return { items: [], total: 0 }
      },
      auditViewPage: async (input: unknown) => {
        calls.push(['view', input])
        return { items: [], total: 0, auditAvailable: true }
      }
    }
  } as unknown as CatalogBackend
  const snapshot = { libraryId: 4, runId: 'run-4', finishedAt: 'now' }
  assert.deepEqual(
    await auditPageThroughBackend(backend, snapshot, {
      section: 'files',
      attention: true,
      limit: 20,
      offset: 5
    }),
    { items: [], total: 0 }
  )
  assert.deepEqual(
    await auditViewPageThroughBackend(backend, snapshot, {
      tab: 'failed',
      outcome: 'all',
      search: 'ABC',
      locale: 'zh-hans-cn',
      limit: 50,
      offset: 0,
      anchor: { kind: 'path', value: '/media/ABC-001.mp4' }
    }),
    { items: [], total: 0, auditAvailable: true }
  )
  assert.deepEqual(calls, [
    [
      'page',
      {
        libraryId: 4,
        section: 'files',
        attention: true,
        limit: 20,
        offset: 5
      }
    ],
    [
      'view',
      {
        libraryId: 4,
        tab: 'failed',
        outcome: 'all',
        search: 'ABC',
        locale: 'zh-hans-cn',
        limit: 50,
        offset: 0,
        anchor: { kind: 'path', value: '/media/ABC-001.mp4' }
      }
    ]
  ])
})

it('routes pending scan get/list/queue reads through the catalog backend', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    libraries: {
      getPendingScan: async (input: unknown) => {
        calls.push(['get', input])
        return { id: 9 }
      },
      listPendingScans: async (input: unknown) => {
        calls.push(['list', input])
        return []
      },
      pagePendingScanQueue: async (input: unknown) => {
        calls.push(['page', input])
        return { items: [], total: 0 }
      },
      countPendingScanQueue: async (input: unknown) => {
        calls.push(['count', input])
        return 2
      }
    }
  } as unknown as CatalogBackend
  assert.deepEqual(await getPendingScanThroughBackend(backend, 1, 9), { id: 9 })
  assert.deepEqual(await listPendingScansThroughBackend(backend, 1), [])
  assert.deepEqual(
    await pagePendingScanQueueThroughBackend(backend, {
      libraryId: 1,
      limit: 50,
      offset: 0,
      anchor: { kind: 'group', id: 9 }
    }),
    { items: [], total: 0 }
  )
  assert.equal(await countPendingScanQueueThroughBackend(backend, 1), 2)
  assert.deepEqual(calls, [
    ['get', { libraryId: 1, groupId: 9 }],
    ['list', { libraryId: 1 }],
    ['page', { libraryId: 1, limit: 50, offset: 0, anchor: { kind: 'group', id: 9 } }],
    ['count', { libraryId: 1 }]
  ])
})

it('routes PENDING_AUDIT_PRESENCE through the catalog backend without frozen emptyInput presence', async () => {
  const calls: unknown[] = []
  const backend = {
    mode: 'remote',
    libraries: {
      pendingAuditPresence: async (input: unknown) => {
        calls.push(input)
        return { groupIds: [1], identityIds: [], scrapeIds: [8] }
      }
    }
  } as unknown as CatalogBackend
  assert.deepEqual(
    await pendingAuditPresenceThroughBackend(backend, 3, {
      groupIds: [1, 2],
      identityIds: [4],
      scrapeIds: [8]
    }),
    { groupIds: [1], identityIds: [], scrapeIds: [8] }
  )
  assert.deepEqual(calls, [
    { libraryId: 3, groupIds: [1, 2], identityIds: [4], scrapeIds: [8] }
  ])
})
