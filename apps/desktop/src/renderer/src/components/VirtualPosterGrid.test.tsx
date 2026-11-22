import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import { setMaxListeners } from 'node:events'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { FixedSizeGrid } from 'react-window'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ActressCard } from '@shared/cardProjection'
import type { VideoCard } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    api: {
      settings: {
        get: async () => ({
          coverDisplayMode: 'portrait',
          coverSizePreset: 'md',
          listLoadMode: 'scroll',
          listPageSize: 100,
          showVideoResourceTypeBadges: false
        }),
        update: async (patch: Record<string, unknown>) => patch
      }
    }
  })
})
setMaxListeners(0, window)
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  documentElement: {}, activeElement: null, body: { appendChild() {} },
  createElement: () => ({ style: {}, offsetWidth: 100, appendChild() {}, remove() {} })
} })
Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ getPropertyValue: () => '' }) })
Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 })
Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} })

let Grid: typeof import('./VirtualPosterGrid')['default']
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
const viewport = { getBoundingClientRect: () => ({ width: 900, height: 600 }), scrollTo() {} }
before(async () => { Grid = (await import('./VirtualPosterGrid')).default })
afterEach(() => { act(() => renderer?.unmount()); client?.clear() })
const video = (id: number): VideoCard => ({ id, code: `TEST-${id}`, title: '测试影片', cover_path: null, scraped_status: 1 })

it('resizes film cards while keeping actress cards and columns stable at the same viewport width', async () => {
  const { DisplayModeProvider } = await import('./DisplayModeContext')
  const { default: CoverSizeSwitch } = await import('./CoverSizeSwitch')
  const { default: ActressGrid } = await import('./VirtualActressGrid')
  const actress: ActressCard = { id: 1, main_name: '测试演员', avatar_path: null, gender: 'female', scraped_status: 1, video_count: 1 }
  const noop = () => {}
  client = new QueryClient()
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter><DisplayModeProvider>
      <CoverSizeSwitch />
      <Grid videos={[video(1)]} />
      <ActressGrid actresses={[actress]} selectedIds={new Set()} selectionMode={false} hasMore={false}
        loadingMore={false} loadMoreFailed={false} onLoadMore={noop} onRetryLoadMore={noop}
        onToggleSelect={noop} onOpen={noop} onDelete={noop} scrollMemoryKey="actresses:size-test" />
    </DisplayModeProvider></MemoryRouter></QueryClientProvider>, { createNodeMock: () => viewport })
  })
  const actressLayout = () => {
    const { columnWidth, rowHeight, columnCount } = renderer!.root.findByType(ActressGrid).findByType(FixedSizeGrid).props
    return { columnWidth, rowHeight, columnCount }
  }
  const baseline = actressLayout()
  const filmWidth = () => renderer!.root.findByType(Grid).findByType(FixedSizeGrid).props.columnWidth
  const standard = filmWidth()
  for (const title of ['小封面', '大封面', '特大封面']) {
    const button = renderer!.root.findAllByType('button').find(node => node.props.title === title)!
    await act(async () => button.props.onClick())
    assert.equal(title === '小封面' ? filmWidth() < standard : filmWidth() > standard, true)
    assert.deepEqual(actressLayout(), baseline)
  }
})

it('retains card buttons and open menus through parent updates, count changes and reordering', async () => {
  client = new QueryClient()
  const render = (videos: VideoCard[], selectedIds = new Set<number>()) => <QueryClientProvider client={client}>
    <MemoryRouter><Grid videos={videos} builtinActions="all" selectedIds={selectedIds} onDelete={() => {}} /></MemoryRouter>
  </QueryClientProvider>
  await act(async () => { renderer = TestRenderer.create(render([video(1), video(2)]), { createNodeMock: () => viewport }) })
  const favorite = () => renderer!.root.findAllByType('button').filter(button => button.props['aria-label'] === '加入收藏')
  const original = favorite()[0]
  assert.ok(original)
  const menu = renderer!.root.findAllByType('button').find(button => button.props['aria-haspopup'] === 'menu')!
  act(() => menu.props.onClick({ stopPropagation() {} }))
  assert.equal(renderer!.root.findAllByProps({ role: 'menu' }).length, 1)
  act(() => renderer!.update(render([video(1), video(2)], new Set([1]))))
  assert.equal(favorite()[0], original, 'updating grid data must not remount its cell type')
  assert.equal(renderer!.root.findAllByProps({ role: 'menu' }).length, 1, 'keep the card interaction state')
  act(() => renderer!.update(render(Array.from({ length: 10 }, (_, index) => video(index + 1)))))
  assert.equal(favorite()[0], original, 'changing inner height must not replace the grid inner component')
  act(() => renderer!.update(render([video(2), video(1)])))
  assert.equal(favorite()[1], original, 'card identity follows the video rather than its grid position')
})

it('renders pagination controls in paged mode and slices items by page size', async () => {
  const { DisplayModeProvider, useDisplayMode } = await import('./DisplayModeContext')
  const allVideos = Array.from({ length: 120 }, (_, index) => video(index + 1))

  function PagedHarness(): JSX.Element {
    const { setListLoadMode, setListPageSize } = useDisplayMode()
    React.useEffect(() => {
      setListLoadMode('paged')
      setListPageSize(50)
    }, [setListLoadMode, setListPageSize])
    return <Grid videos={allVideos} scrollMemoryKey="library:1:paged-test" />
  }

  client = new QueryClient()
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DisplayModeProvider>
            <PagedHarness />
          </DisplayModeProvider>
        </MemoryRouter>
      </QueryClientProvider>,
      { createNodeMock: () => viewport }
    )
  })

  const nav = renderer!.root.findByProps({ 'data-list-pagination': true })
  assert.ok(nav)
  const pageButtons = nav.findAllByType('button')
  const page2Btn = pageButtons.find((btn) => btn.props['aria-label'] === '第 2 页')
  assert.ok(page2Btn)
  await act(async () => {
    page2Btn.props.onClick()
  })
  assert.equal(
    renderer!.root.findByProps({ 'aria-label': '第 2 页' }).props['aria-current'],
    'page'
  )
})
