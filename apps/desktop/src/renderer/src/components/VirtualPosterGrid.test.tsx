import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import { setMaxListeners } from 'node:events'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VideoCard } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { api: {} }) })
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
