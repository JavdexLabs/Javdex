import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { FixedSizeList } from 'react-window'
import type { LibraryScanSummary } from '@shared/libraryTypes'
import type { ScanAuditSnapshotIdentity, ScanAuditViewQuery, ScanAuditViewPage } from '@shared/scanAuditReadTypes'
import type { ViewItem } from '@shared/scanAuditView'
import styles from './LibraryScanAuditPanel.module.css'

type Request = { snapshot: ScanAuditSnapshotIdentity; query: ScanAuditViewQuery }
const requests: Request[] = []
const presence: number[][] = []
let read: (request: Request) => Promise<ScanAuditViewPage>
let refresh: () => Promise<void>
const refreshHistory = (): Promise<void> => refresh()
let refreshCount = 0
let focused: string[] = []
let openedVideo: number[] = []
const noSelect = (): void => undefined
const focusDocument = { body: {}, documentElement: {}, activeElement: {} }
Object.defineProperty(globalThis, 'document', { configurable: true, value: focusDocument })
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'tr-TR', platform: 'Win32' } })
Object.defineProperty(globalThis, 'window', { configurable: true, value: {
  api: { scan: {
    getAuditViewPage: (snapshot: ScanAuditSnapshotIdentity, query: ScanAuditViewQuery) => {
      const request = { snapshot, query }; requests.push(request); return read(request)
    },
    pendingAuditPresence: async (_libraryId: number, ids: { groupIds: number[]; identityIds: number[]; scrapeIds: number[] }) => {
      presence.push([...ids.groupIds, ...ids.identityIds, ...ids.scrapeIds]); return ids
    },
    revealAuditFile: async () => ({ ok: true })
  } },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  setTimeout, clearTimeout
} })
let Panel: typeof import('./LibraryScanAuditPanel').default
let UnrecognizedRow: typeof import('./UnrecognizedRow').default
before(async () => {
  Panel = (await import('./LibraryScanAuditPanel')).default
  UnrecognizedRow = (await import('./UnrecognizedRow')).default
})
let renderer: TestRenderer.ReactTestRenderer | undefined
let props: React.ComponentProps<typeof Panel>
function summary(libraryId = 1, runId = 'run'): LibraryScanSummary {
  return { libraryId, runId, configRevision: 1, trigger: 'manual', startedAt: 'start', finishedAt: 'finish',
    status: 'success', scannedFiles: 205, resourcesAdded: 205, resourcesUpdated: 0, resourcesRemoved: 1,
    primaryResourcesPromoted: 1, videosDeleted: 1, skippedFiles: 0, failedFiles: 0, pendingScanGroups: 0,
    pendingScanResources: 0, offlineFolders: [], errorSummary: null }
}
function row(id: number, label = `row-${id}`): ViewItem {
  return { key: `file:${id}`, title: label, detail: 'server detail', path: `/file-${id}`, videoId: id }
}
function page(request: Request, items: ViewItem[] = [row(1)], extra: Partial<ScanAuditViewPage> = {}): ScanAuditViewPage {
  return { snapshot: request.snapshot, items, total: items.length, limit: 100, offset: request.query.offset ?? 0,
    anchorOffset: null, attentionBadgeCount: 777, auditAvailable: true, ...extra }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function mount(reader: typeof read = async request => page(request)): Promise<void> {
  requests.length = 0; presence.length = 0; focused = []; openedVideo = []; refreshCount = 0
  focusDocument.activeElement = focusDocument.body
  read = reader; refresh = async () => { refreshCount++ }
  props = { summary: summary(), selected: null, revision: 1, onRefreshHistory: refreshHistory,
    onSelect: noSelect, onOpenPending: () => undefined, onOpenVideo: id => openedVideo.push(id) }
  await act(async () => {
    renderer = TestRenderer.create(<Panel {...props} />, { createNodeMock: element => {
      if (element.props.className !== styles.list) return null
      return { querySelectorAll: (selector: string) => {
        assert.equal(selector, '[data-audit-anchor]')
        return rows().map(node => ({ dataset: { auditAnchor: node.props['data-audit-anchor'] },
          scrollIntoView: () => undefined, focus: () => focused.push(node.props['data-audit-anchor']) }))
      } }
    } })
  })
}
async function update(next: Partial<typeof props>): Promise<void> {
  props = { ...props, ...next }
  await act(async () => renderer!.update(<Panel {...props} />))
}
function text(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('')
}
function rows(): TestRenderer.ReactTestInstance[] {
  return renderer!.root.findAll(node => node.type === 'div' && node.props['data-audit-anchor'] !== undefined)
}
function button(label: string): TestRenderer.ReactTestInstance {
  return renderer!.root.findAllByType('button').find(node => text(node) === label)!
}
async function click(label: string): Promise<void> { await act(async () => button(label).props.onClick()) }
async function tab(label: string): Promise<void> {
  const nav = renderer!.root.findByProps({ 'aria-label': '扫描审计分类' })
  const target = nav.findAllByType('button').find(node => node.findAllByType('span').some(span => text(span) === label))!
  await act(async () => target.props.onClick())
}
async function type(value: string): Promise<void> {
  await act(async () => renderer!.root.findByProps({ 'aria-label': '搜索扫描明细' }).props.onChange({ target: { value } }))
}
async function tick(ms = 10): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function wait(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await tick()
  assert.ok(check(), 'condition did not settle')
}
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined })

it('uses server totals/offset, 100/100/5 rows, browser locale and current-page presence', async () => {
  await mount(async request => {
    const offset = request.query.offset ?? 0
    return page(request, Array.from({ length: Math.min(100, 205 - offset) }, (_, i) => ({ ...row(offset + i + 1),
      pendingTarget: { domain: 'scrape', id: String(offset + i + 1) } })), { total: 205 })
  })
  assert.equal(rows().length, 100)
  assert.match(text(renderer!.root), /异常与待办777/)
  assert.match(text(renderer!.root), /205 项/)
  assert.equal(requests[0].query.locale, 'tr-TR')
  await click('下一页'); assert.equal(rows().length, 100)
  await click('下一页'); assert.equal(rows().length, 5)
  assert.deepEqual(requests.map(request => request.query.offset), [0, 100, 200])
  assert.deepEqual(presence.map(ids => ids.length), [100, 100, 5])
  assert.ok(presence.every(ids => ids.length <= 100))
  assert.equal(button('下一页').props.disabled, true)
  // The service clamps after shrink; its returned offset drives the pager.
  read = async request => page(request, [row(101)], { total: 101, offset: 100 })
  await update({ revision: 2 })
  assert.match(text(renderer!.root), /2 \/ 2/)
  assert.equal(rows().length, 1)
})

it('hides rows during loading/error and waits for refreshed header before retrying current props', async () => {
  const initial = deferred<ScanAuditViewPage>()
  await mount(() => initial.promise)
  assert.equal(rows().length, 0)
  assert.match(text(renderer!.root), /正在读取/)
  assert.doesNotMatch(text(renderer!.root), /没有符合/)
  await act(async () => initial.reject(Error('expired')))
  assert.match(text(renderer!.root), /读取失败：expired/)
  const header = deferred<void>()
  refresh = () => { refreshCount++; return header.promise }
  await click('重试')
  await update({ revision: 2 })
  assert.equal(requests.length, 1, 'same-summary revision must wait for header completion')
  read = async request => page(request, [row(2, 'refreshed')])
  await act(async () => header.resolve())
  assert.equal(requests.length, 2)
  assert.equal(refreshCount, 1)
  assert.match(text(renderer!.root), /refreshed/)
  read = async () => { throw Error('expired again') }
  await update({ revision: 3 })
  const nextHeader = deferred<void>()
  refresh = () => nextHeader.promise
  await click('重试')
  read = async request => page(request, [row(3, 'new snapshot')])
  await act(async () => { props = { ...props, summary: summary(1, 'new-run'), revision: 4 }; renderer!.update(<Panel {...props} />); nextHeader.resolve() })
  assert.equal(requests.at(-1)?.snapshot.runId, 'new-run')
  assert.equal(requests.filter(request => request.snapshot.runId === 'run').length, 3)
})

for (const finish of ['resolve', 'reject'] as const) it(`isolates old retry ${finish} across library A → B → A`, async () => {
  await mount(async () => { throw Error('A error') })
  const headerA = deferred<void>()
  refresh = () => headerA.promise
  await click('重试')
  read = async request => page(request, [row(1, `library-${request.snapshot.libraryId}`)])
  await update({ summary: summary(2) })
  assert.match(text(renderer!.root), /library-2/)
  assert.doesNotMatch(text(renderer!.root), /正在读取|A error/)
  await update({ summary: summary(1) })
  assert.match(text(renderer!.root), /library-1/)
  const count = requests.length
  await act(async () => { if (finish === 'resolve') headerA.resolve(); else headerA.reject(Error('late A header error')) })
  assert.equal(requests.length, count)
  assert.match(text(renderer!.root), /library-1/)
  assert.doesNotMatch(text(renderer!.root), /late A header error|正在读取/)
})

it('debounces 200ms, hides rows immediately, and rejects search ABA and library ABA responses', async () => {
  await mount()
  await tab('全部文件')
  const pending: Array<{ request: Request; gate: ReturnType<typeof deferred<ScanAuditViewPage>> }> = []
  read = request => { const gate = deferred<ScanAuditViewPage>(); pending.push({ request, gate }); return gate.promise }
  const count = requests.length
  await type('a'); await type('ab'); await type('abc')
  assert.equal(rows().length, 0)
  await tick(100)
  assert.equal(requests.length, count)
  await wait(() => pending.length === 1)
  assert.equal(pending[0].request.query.search, 'abc')
  await type('b'); await wait(() => pending.length === 2)
  await type('abc'); await wait(() => pending.length === 3)
  await act(async () => pending[2].gate.resolve(page(pending[2].request, [row(3, 'new A')])) )
  await act(async () => { pending[0].gate.resolve(page(pending[0].request, [row(1, 'old A')])); pending[1].gate.reject(Error('old B')) })
  assert.match(text(renderer!.root), /new A/)
  assert.doesNotMatch(text(renderer!.root), /old A|old B/)
  await update({ revision: 2 }); await wait(() => pending.length === 4)
  await update({ summary: summary(2) }); await wait(() => pending.some(entry => entry.request.snapshot.libraryId === 2))
  await update({ summary: summary(1) }); await wait(() => pending.at(-1)?.request.snapshot.libraryId === 1)
  const last = pending.at(-1)!
  await act(async () => last.gate.resolve(page(last.request, [row(4, 'new library A')])))
  await act(async () => pending[3].gate.resolve(page(pending[3].request, [row(5, 'old library A')])))
  assert.match(text(renderer!.root), /new library A/)
  assert.doesNotMatch(text(renderer!.root), /old library A/)
})

it('cancels a search timer on library change and unmount; filters reset offset and use the server', async () => {
  await mount(async request => page(request, Array.from({ length: 100 }, (_, i) => row(i + 1)), { total: 205 }))
  await tab('全部文件'); await click('下一页')
  await type('queued')
  await update({ summary: summary(2) })
  await tick(250)
  assert.ok(requests.every(request => request.query.search !== 'queued'))
  await tab('全部文件'); await click('下一页')
  await act(async () => renderer!.root.findByProps({ 'aria-label': '筛选扫描结果' }).props.onChange({ target: { value: 'skipped' } }))
  assert.equal(requests.at(-1)?.query.offset, 0)
  assert.equal(requests.at(-1)?.query.outcome, 'skipped')
  await tab('已跳过')
  assert.equal(renderer!.root.findByType(FixedSizeList).props.itemSize, 48)
  await tab('新增与更新')
  assert.equal(renderer!.root.findByType(FixedSizeList).props.itemSize, 72)
  await tab('资源清理'); await click('移除资源 (1)')
  assert.equal(requests.at(-1)?.query.changesFilter, 'removed')
  await tab('全部文件'); await type('unmounted')
  const count = requests.length
  await act(async () => renderer!.unmount()); renderer = undefined
  await tick(250)
  assert.equal(requests.length, count)
})

it('resolves unrecognized once through header refresh and refetches the current page', async () => {
  await mount(async request => page(request, [{ ...row(101), rootId: 7, isUnrecognizedPending: true }], { total: 201 }))
  await click('下一页')
  const header = deferred<void>()
  refresh = () => { refreshCount++; return header.promise }
  await act(async () => renderer!.root.findByType(UnrecognizedRow).props.onResolved('/file-101'))
  assert.equal(refreshCount, 1)
  const count = requests.length
  await update({ revision: 2 })
  assert.equal(requests.length, count)
  read = async request => page(request, [row(102, 'resolved refresh')], { total: 201 })
  await act(async () => header.resolve())
  assert.equal(requests.at(-1)?.query.offset, 100)
  assert.equal(requests.length, count + 1)
  assert.match(text(renderer!.root), /resolved refresh/)
})

it('renders missing-body notice alongside cached rows and never calls it a filtered empty page', async () => {
  await mount(async request => page(request, request.query.tab === 'failed' ? [row(1, 'cached')] : [], { auditAvailable: false }))
  assert.match(text(renderer!.root), /cached/)
  assert.match(text(renderer!.root), /仅保留了摘要/)
  await tab('全部文件')
  assert.match(text(renderer!.root), /仅保留了摘要/)
  assert.doesNotMatch(text(renderer!.root), /没有符合条件/)
})

for (const kind of ['path', 'group'] as const) it(`anchors all → failed by ${kind}, honors returned page and safely focuses exact DOM anchor`, async () => {
  const path = '/odd/" ] [data-evil="yes]\\文件.mp4'
  const target: ViewItem = { ...row(1, 'target'), path, requiresAttention: true, ...(kind === 'group' ? { groupId: 73 } : {}) }
  await mount(async request => page(request, [target], request.query.anchor ? { offset: 100, anchorOffset: 100, total: 201 } : {}))
  await tab('全部文件')
  await click('处理')
  assert.deepEqual(requests.at(-1)?.query.anchor, kind === 'group' ? { kind: 'group', id: 73 } : { kind: 'path', value: path })
  assert.equal(requests.at(-1)?.query.tab, 'failed')
  await wait(() => focused.length === 1)
  assert.equal(focused[0], kind === 'group' ? 'group:73' : `path:${encodeURIComponent(path)}`)
  assert.match(text(renderer!.root), /2 \/ 3/)
  const list = renderer!.root.findByProps({ className: styles.list })
  await act(async () => list.props.onClick({ target: { closest: () => ({ dataset: { videoId: '1' } }) } }))
  assert.deepEqual(openedVideo, [1])
  await click('下一页')
  assert.equal(requests.at(-1)?.query.offset, 200)
  assert.equal(requests.at(-1)?.query.anchor, undefined)
})

for (const nextRun of ['run', 'next'] as const) it(`waits for delayed header props after refresh promise resolves (${nextRun})`, async () => {
  await mount(async () => { throw Error('retry required') })
  refresh = async () => { refreshCount++ }
  await click('重试')
  await tick(30)
  assert.equal(refreshCount, 1)
  assert.equal(requests.length, 1, 'resolved callback alone cannot refetch the old snapshot')
  assert.match(text(renderer!.root), /正在读取/)
  read = async request => page(request, [row(1, 'header observed')])
  await update({ summary: summary(1, nextRun), revision: 2 })
  assert.equal(requests.length, 2)
  assert.equal(requests.at(-1)?.snapshot.runId, nextRun)
  assert.match(text(renderer!.root), /header observed/)
})

it('shows refresh errors with retry and allows a new library to proceed', async () => {
  await mount(async () => { throw Error('page failed') })
  refresh = async () => { throw Error('header failed') }
  await click('重试')
  assert.match(text(renderer!.root), /header failed/)
  assert.equal(requests.length, 1)
  assert.ok(button('重试'))
  read = async request => page(request, [row(1, 'new library')])
  await update({ summary: summary(2) })
  assert.match(text(renderer!.root), /new library/)
  assert.doesNotMatch(text(renderer!.root), /header failed/)
})

for (const destination of ['origin', 'body', 'documentElement', 'input', 'toolbar'] as const) {
  it(`held anchor response respects user focus: ${destination}`, async () => {
    const target = { ...row(1, 'held target'), requiresAttention: true }
    const held = deferred<ScanAuditViewPage>()
    await mount(async request => request.query.anchor ? held.promise : page(request, [target]))
    await tab('全部文件')
    const origin = { name: 'processing button' }
    focusDocument.activeElement = origin
    await click('处理')
    const currentFocus = destination === 'origin' ? origin
      : destination === 'body' ? focusDocument.body
      : destination === 'documentElement' ? focusDocument.documentElement
      : { name: destination }
    focusDocument.activeElement = currentFocus
    assert.equal(focused.length, 0)
    await act(async () => held.resolve(page(requests.at(-1)!, [target], { offset: 100, anchorOffset: 100, total: 201 })))
    await tick(20)
    if (destination === 'input' || destination === 'toolbar') {
      assert.deepEqual(focused, [])
      assert.strictEqual(focusDocument.activeElement, currentFocus)
      // Subsequent rerenders must not revive the skipped automatic focus.
      await update({ revision: 2 })
      await tick(20)
      assert.deepEqual(focused, [])
    } else {
      assert.deepEqual(focused, ['path:%2Ffile-1'])
    }
  })
}

it('keeps the actual anchored page when resolving its target, clears anchor and accepts server clamp', async () => {
  const target: ViewItem = { ...row(201, 'anchor target'), rootId: 7, requiresAttention: true }
  await mount(async request => page(request,
    [{ ...target, ...(request.query.tab === 'failed' ? { isUnrecognizedPending: true } : {}) }],
    request.query.anchor ? { offset: 200, anchorOffset: 200, total: 201 } : {}))
  await tab('全部文件')
  await click('处理')
  assert.deepEqual(requests.at(-1)?.query.anchor, { kind: 'path', value: '/file-201' })
  assert.match(text(renderer!.root), /3 \/ 3/)
  const header = deferred<void>()
  refresh = () => { refreshCount++; return header.promise }
  const count = requests.length
  await act(async () => renderer!.root.findByType(UnrecognizedRow).props.onResolved('/file-201'))
  assert.equal(refreshCount, 1)
  assert.equal(requests.length, count)
  read = async request => page(request, [row(101, 'remaining last page')], { total: 101, offset: 100 })
  await update({ revision: 2 })
  assert.equal(requests.length, count)
  await act(async () => header.resolve())
  assert.equal(refreshCount, 1)
  assert.equal(requests.length, count + 1)
  assert.equal(requests.at(-1)?.query.anchor, undefined)
  assert.equal(requests.at(-1)?.query.offset, 200)
  assert.match(text(renderer!.root), /2 \/ 2/)
  assert.match(text(renderer!.root), /remaining last page/)
})

it('late resolution from an old row cannot reset the user’s newer page', async () => {
  await mount(async request => page(request,
    [{ ...row((request.query.offset ?? 0) + 1), rootId: 7, isUnrecognizedPending: true }], { total: 301 }))
  await click('下一页')
  const oldResolved = renderer!.root.findByType(UnrecognizedRow).props.onResolved
  await click('下一页')
  assert.equal(requests.at(-1)?.query.offset, 200)
  const header = deferred<void>()
  refresh = () => { refreshCount++; return header.promise }
  await act(async () => oldResolved('/file-101'))
  await update({ revision: 2 })
  await act(async () => header.resolve())
  assert.equal(refreshCount, 1)
  assert.equal(requests.at(-1)?.query.offset, 200)
  assert.match(text(renderer!.root), /3 \/ 4/)
})

it('late resolution from library A cannot replace B or a new A page state', async () => {
  await mount(async request => page(request,
    [{ ...row((request.query.offset ?? 0) + 1), rootId: 7, isUnrecognizedPending: true }], { total: 301 }))
  await click('下一页')
  const oldResolved = renderer!.root.findByType(UnrecognizedRow).props.onResolved
  await update({ summary: summary(2) })
  await click('下一页'); await click('下一页')
  await act(async () => oldResolved('/file-101'))
  assert.match(text(renderer!.root), /3 \/ 4/)
  assert.equal(requests.at(-1)?.snapshot.libraryId, 2)
  await update({ summary: summary(1) })
  await click('下一页'); await click('下一页')
  await act(async () => oldResolved('/file-101'))
  assert.match(text(renderer!.root), /3 \/ 4/)
  assert.equal(requests.at(-1)?.query.offset, 200)
})
