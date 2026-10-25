import assert from 'node:assert/strict'
import { afterEach, test, type TestContext } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { PointerTiming } from '@shared/desktop/input'

let loadTiming = async (): Promise<PointerTiming> => ({ doubleClickMs: 500, source: 'chromium' })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
  api: { desktop: { pointerTiming: () => loadTiming() } }, setTimeout, clearTimeout
}) })
type Gestures = ReturnType<typeof import('./usePlaybackPointerGestures').usePlaybackPointerGestures>
type Scope = Parameters<typeof import('./usePlaybackPointerGestures').usePlaybackPointerGestures>[0]
const initial: Scope = { sessionId: 'first', sharedTextureSurface: 'gpu', presentation: 'expanded', phase: 'playing' }
let gestures: Gestures, renderer: TestRenderer.ReactTestRenderer | undefined
let changeScope: (value: Scope) => Promise<void>
async function mount(): Promise<void> {
  const { usePlaybackPointerGestures } = await import('./usePlaybackPointerGestures')
  function Fixture({ scope }: { scope: Scope }) { gestures = usePlaybackPointerGestures(scope); return null }
  await act(async () => { renderer = TestRenderer.create(React.createElement(Fixture, { scope: initial })) })
  changeScope = value => act(async () => { renderer!.update(React.createElement(Fixture, { scope: value })) })
}
function clock(context: TestContext) {
  let now = 0, id = 0
  const timers = new Map<number, { due: number; callback: () => void }>()
  context.mock.method(performance, 'now', () => now)
  context.mock.method(window, 'setTimeout', (callback: () => void, ms: number) => { timers.set(++id, { due: now + ms, callback }); return id })
  context.mock.method(window, 'clearTimeout', (key: number) => { timers.delete(key) })
  return {
    timers,
    advance: (ms: number) => act(async () => {
      now += ms
      for (const [key, timer] of [...timers]) if (timer.due <= now) { timers.delete(key); timer.callback() }
    })
  }
}
afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = undefined
  loadTiming = async () => ({ doubleClickMs: 500, source: 'chromium' })
})

test('a slow platform double click and held second press never commit a single click', async context => {
  const time = clock(context)
  loadTiming = async () => ({ doubleClickMs: 1500, source: 'system' })
  await mount()
  let activated = 0
  await act(async () => gestures.click(1, true, () => activated++))
  await time.advance(1400)
  assert.equal(activated, 0)
  gestures.onMouseDown({ button: 0, detail: 2 })
  await time.advance(2000)
  gestures.click(2, true, () => activated++)
  assert.equal(activated, 0)
})

test('focus refresh observes changed platform timing for the next gesture', async context => {
  const time = clock(context)
  await mount()
  loadTiming = async () => ({ doubleClickMs: 800, source: 'system' })
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  let activated = 0
  await act(async () => gestures.click(1, true, () => activated++))
  await time.advance(600)
  assert.equal(activated, 0)
  await time.advance(250)
  assert.equal(activated, 1)
})

test('a late timing reply cannot resurrect a canceled click', async context => {
  const time = clock(context)
  let resolve!: (timing: PointerTiming) => void
  loadTiming = () => new Promise(done => { resolve = done })
  await mount()
  let activated = 0
  gestures.click(1, true, () => activated++)
  gestures.cancel()
  await act(async () => resolve({ doubleClickMs: 500, source: 'chromium' }))
  await time.advance(6000)
  assert.equal(activated, 0)
  assert.equal(time.timers.size, 0)
})

test('timing lookup does not add another full delay after the click deadline', async context => {
  const time = clock(context)
  let resolve!: (timing: PointerTiming) => void
  loadTiming = () => new Promise(done => { resolve = done })
  await mount()
  let activated = 0
  gestures.click(1, true, () => activated++)
  await time.advance(700)
  await act(async () => resolve({ doubleClickMs: 500, source: 'chromium' }))
  await time.advance(0)
  assert.equal(activated, 1)
})

test('failed timing lookup stays conservative while keyboard activation remains immediate', async context => {
  const time = clock(context)
  loadTiming = async () => { throw new Error('IPC unavailable') }
  await mount()
  let activated = 0
  await act(async () => gestures.click(1, true, () => activated++))
  await time.advance(1000)
  assert.equal(activated, 0)
  gestures.click(0, true, () => activated++)
  assert.equal(activated, 1)
  await time.advance(6000)
  assert.equal(activated, 1)
})

for (const [label, next] of [
  ['session', { ...initial, sessionId: 'replacement' }],
  ['surface', { ...initial, sharedTextureSurface: 'cpu:replacement' }],
  ['presentation', { ...initial, presentation: 'docked' }],
  ['error', { ...initial, phase: 'error' }],
  ['stop', null]
] as const) test(`changing ${label} cancels the old click`, async context => {
  const time = clock(context)
  await mount()
  let activated = 0
  await act(async () => gestures.click(1, true, () => activated++))
  await changeScope(next)
  await time.advance(600)
  assert.equal(activated, 0)
})
