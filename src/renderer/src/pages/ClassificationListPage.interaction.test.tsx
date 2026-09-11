import { continuousViewport } from '../test/continuousViewport'
import ContinuousGrid from '../components/ContinuousGrid'
import assert from 'node:assert/strict'
import { afterEach, before, describe, it } from 'node:test'
import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, useLocation, useNavigate, useParams } from 'react-router-dom'
import TestRenderer, { act } from 'react-test-renderer'
import type { OrganizationRole, ClassificationListPage, SeriesListItem, SeriesListQuery, ClassificationPageQuery } from '@shared/classificationTypes'
import { parseFacetOffset, parsePlaylistOffset, classificationListQueryHash } from '../listView/listQueryParams'

type Input = SeriesListQuery & ClassificationPageQuery & { role?: OrganizationRole | 'director' | 'series' }
type Page = ClassificationListPage<SeriesListItem>
const requests: Input[] = []
let total = 125
let read: (query: Input) => Promise<Page>
function result(query: Input): Page {
  const offset = query.offset ?? 0
  return {
    items: Array.from({ length: Math.max(0, Math.min(60, total - offset)) }, (_, index) => ({
      id: offset + index + 1, mainName: `${query.role ?? 'series'}:${query.search}:${offset + index + 1}`,
      imagePath: index % 2 ? null : 'classification/explicit.jpg', fallbackCoverPath: 'classification/fallback.jpg', ownerOrganization: null, videoCount: 1, updatedAt: ''
    })), total, limit: 60, offset
  }
}
const page = (query: Input): Promise<Page> => { requests.push(query); return read(query) }
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {
  directors: { page: (query: Input) => page({ ...query, role: 'director' }), list: () => { throw Error('Full list forbidden') } },
  series: { page: (query: Input) => page({ ...query, role: 'series' }), list: () => { throw Error('Full list forbidden') } },
  organizations: { page, list: () => { throw Error('Full list forbidden') } }
} } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform: 'Win32' } })
let DirectorListPage: typeof import('./DirectorListPage').default
let SeriesListPage: typeof import('./SeriesListPage').default
let OrganizationListPage: typeof import('./OrganizationListPage').default
let ListDetailShell: typeof import('../components/ListDetailShell').default
before(async () => {
  DirectorListPage = (await import('./DirectorListPage')).default
  SeriesListPage = (await import('./SeriesListPage')).default
  OrganizationListPage = (await import('./OrganizationListPage')).default
  ListDetailShell = (await import('../components/ListDetailShell')).default
})
let viewport=continuousViewport(), position=0
let renderer: TestRenderer.ReactTestRenderer
let client: QueryClient
let location: ReturnType<typeof useLocation>
let navigate: ReturnType<typeof useNavigate>
const scroll = {
  scrollTop: 0,
  addEventListener: () => {},
  removeEventListener: () => {},
  scrollTo: ({ top }: { top: number }) => { scroll.scrollTop = top }
}
function Probe(): null { location = useLocation(); navigate = useNavigate(); return null }
function Surface(): React.JSX.Element {
  const { type } = useParams()
  return <ListDetailShell list={type === 'series' ? <SeriesListPage /> : type === 'director' ? <DirectorListPage /> : <OrganizationListPage role={type as OrganizationRole} />}
    detailMatchPath={['/facet/director/d/:id', '/facet/series/s/:id', '/facet/:type/o/:id']} detailMatchEnd={false} />
}
async function mount(kind: string, query = ''): Promise<void> {
  viewport=continuousViewport();position=Number(new URLSearchParams(query).get('facetOffset'))||0
  total = 125; requests.length = 0; read = async query => result(query)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/facet/${kind}${query}`]}><Probe /><Routes>
        <Route path="/facet/:type" element={<Surface />}>
          <Route path="d/:id/*" element={<div>detail</div>} />
          <Route path="s/:id/*" element={<div>detail</div>} />
          <Route path="o/:id/*" element={<div>detail</div>} />
        </Route>
      </Routes></MemoryRouter>
    </QueryClientProvider>, { createNodeMock: element =>
      viewport.createNodeMock(element) ?? (element.props.className === 'scroll-body scroll-body--scroll' ? scroll : null) })
  })
  await wait(() => cards().length > 0)
}
async function wait(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  assert.ok(check(), 'condition did not settle')
}
function text(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(text).join('')
}
function cards(): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByProps({ className: 'facet-card card-interactive' })
}
function button(label: string): TestRenderer.ReactTestInstance {
  return renderer.root.findAllByType('button').find(node => text(node) === label)!
}
async function click(label: string): Promise<void> { if(label==='下一页'||label==='上一页'){position=Math.max(0,position+(label==='下一页'?60:-60));await viewport.scroll(renderer,position);return} await act(async () => { button(label).props.onClick() }) }
async function go(url: string | number): Promise<void> {
  await act(async () => { if (typeof url === 'number') navigate(url); else navigate(url) })
}
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount())
  client?.clear()
})

for (const kind of ['series', 'maker', 'director']) describe(`${kind} real list page`, () => {
  it('renders 60/60/5 with server total and bounded page cache', async () => {
    await mount(kind)
    assert.ok(cards().length > 0 && cards().length <= 8)
    assert.deepEqual(cards().slice(0,2).map(card=>card.findByType('img').props.src), ['media://classification/explicit.jpg?size=640','media://classification/fallback.jpg?size=640'])
    assert.ok(text(renderer.root).includes('共 125'))
    assert.equal(button('上一页'), undefined)
    await click('下一页'); await wait(() => cards().length > 0 && cards().some(card=>text(card).includes(':61')))
    assert.equal(location.search, '?facetOffset=60')
    await click('下一页'); await wait(() => cards().length > 0 && cards().length <= 8)
    assert.equal(button('下一页'), undefined)
    await click('上一页'); await wait(() => cards().length > 0)
    assert.deepEqual(requests.map(query => query.offset), [0, 60, 120])
    assert.ok(requests.every(query => query.limit === 60))
    total = 6000
    await act(async()=>renderer.root.findByType(ContinuousGrid).props.window.retry())
    for (let offset = 120; offset < 6000; offset += 60) {
      await viewport.scroll(renderer,offset)
      await wait(() => cards().length > 0 && cards().some(card=>text(card).includes(`:${offset + 1}`)))
    }
    await wait(() => renderer.root.findByType(ContinuousGrid).props.window.total === 6000)
  })
  it('clears old cards while loading and supports failed-page retry', async () => {
    await mount(kind)
    let reject!: (error: Error) => void
    read = () => new Promise((_resolve, fail) => { reject = fail })
    await click('下一页')
    assert.ok(cards().length <= 1)
    await act(async () => reject(Error('page unavailable')))
    await wait(() => Boolean(button('重试')))
    assert.ok(cards().length <= 1)
    read = async query => result(query)
    await click('重试'); await wait(() => cards().length > 0)
    assert.ok(cards().some(card=>text(card).includes(':61')))
  })
  it('clamps a shrinking total to its last page, including zero', async () => {
    await mount(kind, '?facetOffset=120')
    total = 61
    await act(async () => { renderer.root.findByType(ContinuousGrid).props.window.retry() })
    await wait(() => location.search === '?facetOffset=60' && renderer.root.findByType(ContinuousGrid).props.window.total === 61)
    total = 0
    await act(async () => { renderer.root.findByType(ContinuousGrid).props.window.retry() })
    await wait(() => location.search === '' && !button('下一页') && text(renderer.root).includes('共 0'))
    assert.equal(cards().length, 0)
    assert.ok(text(renderer.root).includes('共 0'))
  })
  it('resets search/sort to page one and rejects late search data', async () => {
    await mount(kind, '?facetOffset=60')
    let resolveOld!: (value: Page) => void
    read = query => query.search === 'old' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(result(query))
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'old' } }))
    assert.equal(renderer.root.findByType('input').props.value, 'old')
    await wait(() => requests.some(query => query.search === 'old'))
    assert.equal(location.search, '?q=old')
    assert.equal(cards().length, 0)
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'new' } }))
    await wait(() => cards().length > 0 && text(cards()[0]).includes(':new:'))
    await act(async () => resolveOld(result({ search: 'old', offset: 0 })))
    assert.ok(text(cards()[0]).includes(':new:'))
    await viewport.scroll(renderer,60); await wait(() => location.search.includes('facetOffset=60'))
    await click('更新'); await wait(() => requests.at(-1)?.sortBy === 'updated_at')
    assert.equal(requests.at(-1)?.offset, 0)
    assert.equal(requests.at(-1)?.search, 'new')
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'discard' } }))
    await go(`/facet/${kind}?q=external&facetOffset=60`)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(renderer.root.findByType('input').props.value, 'external')
    assert.equal(location.search, '?q=external&facetOffset=60')
  })
  it('invalidates uncommitted input across A → B → A history navigation', async () => {
    await mount(kind, '?q=original&facetOffset=60')
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'discard' } }))
    await go(`/facet/${kind}?q=other`)
    await go(-1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(location.search, '?q=original&facetOffset=60')
    assert.equal(renderer.root.findByType('input').props.value, 'original')
    assert.ok(requests.every(query => query.search !== 'discard'))
  })
  it('invalidates pending input when opening detail without changing search', async () => {
    await mount(kind, '?q=original&facetOffset=60')
    await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'discard' } }))
    await act(async () => cards()[0].props.onClick())
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(location.search, '?q=original&facetOffset=60')
    assert.equal(renderer.root.findByType('input').props.value, 'original')
    await go(-1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    assert.equal(location.search, '?q=original&facetOffset=60')
    assert.ok(requests.every(query => query.search !== 'discard'))
  })
  it('retains page, active observer and scroll through nested detail and return', async () => {
    await mount(kind, '?q=kept&facetOffset=60')
    await viewport.scroll(renderer,60)
    await act(async () => cards().find(card=>text(card).includes(':61'))!.props.onClick())
    assert.ok(location.pathname.includes(kind === 'series' ? '/s/61' : kind === 'director' ? '/d/61' : '/o/61'))
    assert.equal(location.search, '?q=kept&facetOffset=60')
    await go(`${location.pathname}/99${location.search}`)
    assert.equal(renderer.root.findAllByType(ContinuousGrid).length, 1)
    await go(-1); await go(-1)
    await wait(() => requests.length >= 2)
    assert.equal(location.pathname, `/facet/${kind}`)
    assert.equal(location.search, '?q=kept&facetOffset=60')
    assert.ok(viewport.owner.scrollTop > 0)
    assert.ok(cards().length > 0 && cards().length <= 8)
    assert.ok(requests.every(query => [0,60].includes(query.offset ?? 0) && query.search === 'kept'))
  })
})
it('loads each facet type after a clean-url switch without stranding loading', async () => {
  await mount('director')
  for (const kind of ['maker', 'publisher', 'series', 'director'] as const) {
    await go(`/facet/${kind}`)
    await wait(() => cards().length > 0 && text(cards()[0]).startsWith(`${kind}::`))
    assert.equal(location.search, '')
    assert.ok(text(renderer.root).includes('共 125'))
  }
})
it('organization role change discards old filters and pending search', async () => {
  await mount('maker', '?q=maker&facetOffset=60')
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'discard' } }))
  await go('/facet/publisher?q=maker&facetOffset=60')
  await wait(() => cards().length > 0 && text(cards()[0]).startsWith('publisher::1'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
  assert.equal(location.search, '')
  assert.equal(renderer.root.findByType('input').props.value, '')
  assert.ok(requests.filter(query => query.role === 'publisher').every(query => query.offset === 0 && query.search === ''))
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'after' } }))
  await wait(() => location.search.includes('q=after'))
  assert.ok(requests.some(query => query.role === 'publisher' && query.search === 'after'))
})
it('normalizes URL offsets safely and keys distinct pages', async () => {
  for (const raw of [null, '', '-60', 'NaN', 'Infinity', '1e3', '60.5', '9007199254740992']) {
    assert.equal(parseFacetOffset(raw), 0)
    assert.equal(parsePlaylistOffset(raw), 0)
  }
  assert.equal(parseFacetOffset('119'), 60)
  assert.equal(parsePlaylistOffset('119'), 60)
  assert.equal(parseFacetOffset('000120'), 120)
  assert.equal(parsePlaylistOffset('000120'), 120)
  assert.notEqual(classificationListQueryHash('series', new URLSearchParams()), classificationListQueryHash('series', new URLSearchParams('facetOffset=60')))
  await mount('series', '?facetOffset=119')
  assert.equal(location.search, '?facetOffset=60')
  assert.equal(requests[0].offset,60)
})
