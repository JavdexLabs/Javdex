import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useContinuousPage } from './useContinuousPage'
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | undefined
async function settle(check: () => boolean) {
  for (let n = 0; n < 80; n++) { if (check()) return; await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)) }) }
  assert.fail('continuous window did not settle')
}
afterEach(async () => { await act(async () => renderer?.unmount()) })
type Page = { items: { id: number }[]; total?: number; hasMore?: boolean; hasExactName?: boolean }
let result!: ReturnType<typeof useContinuousPage<Page>>
function Harness({ scope = 'one', size = 60, enabled = true, initialOffset = 0, read }: { scope?: string; size?: number; enabled?: boolean; initialOffset?: number; read: (offset: number) => Promise<Page> }) {
  result = useContinuousPage(scope, size, read, enabled, initialOffset)
  return null
}
const makePage = (offset: number, total = 7200): Page => ({ items: Array.from({ length: Math.min(60, Math.max(0, total - offset)) }, (_, i) => ({ id: offset + i + 1 })), total })
it('retains at most three pages through 100 positions and reloads evicted rows', async () => {
  const calls: number[] = []
  const read = async (offset: number) => { calls.push(offset); return makePage(offset) }
  await act(async () => { renderer = TestRenderer.create(<Harness read={read} />) })
  for (let n = 1; n < 100; n++) {
    act(() => result.window.onVisibleRange(n * 60, n * 60 + 20))
    await settle(() => result.window.getItem(n * 60)?.id === n * 60 + 1)
    assert.ok(result.items.length <= 180)
  }
  assert.equal(result.window.getItem(0), undefined)
  act(() => result.window.onVisibleRange(0, 20)); await settle(() => result.window.getItem(0)?.id === 1)
  assert.equal(calls.filter(offset => offset === 0).length, 2)
  assert.ok(calls.length <= 102, 'retained pages must not be repeatedly read')
})
it('preserves total and existing rows on a page error, then retries that window', async () => {
  let fail = true
  const read = async (offset: number) => { if (offset === 60 && fail) throw Error('offline'); return makePage(offset) }
  await act(async () => { renderer = TestRenderer.create(<Harness read={read} />) })
  act(() => result.window.onVisibleRange(60, 80)); await settle(() => Boolean(result.error))
  assert.equal(result.total, 7200); assert.equal(result.window.getItem(0)?.id, 1)
  fail = false; act(() => result.reload()); await settle(() => result.window.getItem(60)?.id === 61)
  assert.equal(result.error, null)
})
it('restarts the same session when re-enabled and ignores a paused response', async () => {
  let resolve!: (page: Page) => void
  const paused = () => new Promise<Page>(done => { resolve = done })
  await act(async () => { renderer = TestRenderer.create(<Harness read={paused} />) })
  await act(async () => { renderer!.update(<Harness enabled={false} read={paused} />) })
  assert.equal(result.loading, false)
  assert.equal(result.known, false)
  await act(async () => { renderer!.update(<Harness enabled={true} read={async offset => makePage(offset, 10)} />) })
  await settle(() => result.total === 10 && result.items.length === 10)
  await act(async () => resolve(makePage(0, 5000)))
  assert.equal(result.total, 10)
  assert.equal(result.items.length, 10)
})
it('keeps loaded rows while disabled and does not refetch them on re-enable', async () => {
  let calls = 0
  const read = async (offset: number) => { calls++; return makePage(offset, 10) }
  await act(async () => { renderer = TestRenderer.create(<Harness read={read} />) })
  await settle(() => result.items.length === 10)
  await act(async () => { renderer!.update(<Harness enabled={false} read={read} />) })
  assert.equal(result.loading, false)
  assert.equal(result.known, true)
  assert.equal(result.items.length, 10)
  assert.equal(result.total, 10)
  await act(async () => { renderer!.update(<Harness enabled={true} read={read} />) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  assert.equal(result.items.length, 10)
  assert.equal(calls, 1)
})
it('isolates stale A→B→A requests and twenty filter changes', async () => {
  let resolve!: (page: Page) => void
  const old = () => new Promise<Page>(done => { resolve = done })
  await act(async () => { renderer = TestRenderer.create(<Harness read={old} />) })
  for (let n = 0; n < 20; n++) await act(async () => { renderer!.update(<Harness scope={String(n)} read={async offset => makePage(offset, 10)} />) })
  await act(async () => resolve(makePage(0, 5000)))
  assert.equal(result.total, 10); assert.equal(result.items.length, 10)
})
it('supports hasMore-only endpoints without collecting all previous pages', async () => {
  const read = async (offset: number) => { const page = makePage(offset, 125); return { items: page.items, hasMore: offset + page.items.length < 125 } }
  await act(async () => { renderer = TestRenderer.create(<Harness read={read} />) })
  assert.equal(result.total, 120)
  act(() => result.window.onVisibleRange(60, 70)); await settle(() => result.window.getItem(60)?.id === 61)
  act(() => result.window.onVisibleRange(120, 124)); await settle(() => result.window.getItem(124)?.id === 125)
  assert.equal(result.total, 125)
})
it('reads hasExactName and hasMore from the session instead of Map insertion order', async () => {
  const read = async (offset: number) => {
    const page = makePage(offset, 125)
    return { items: page.items, total: 125, hasMore: offset + page.items.length < 125, hasExactName: offset === 0 }
  }
  await act(async () => { renderer = TestRenderer.create(<Harness initialOffset={120} read={read} />) })
  await settle(() => result.window.getItem(120)?.id === 121)
  assert.equal(result.page?.hasMore, false)
  assert.equal(result.page?.hasExactName, false)
  act(() => result.window.onVisibleRange(0, 20)); await settle(() => result.window.getItem(0)?.id === 1)
  assert.equal(result.page?.hasExactName, true)
  assert.equal(result.page?.hasMore, false)
})

for (const size of [40, 100]) it(`bounds ${size}-item endpoints through 100 pages`, async () => {
  const read = async (offset: number): Promise<Page> => ({ items: Array.from({ length: size }, (_, i) => ({ id: offset + i + 1 })), total: size * 110 })
  await act(async () => { renderer = TestRenderer.create(<Harness size={size} read={read} />) })
  for (let index = 0; index < 100; index++) {
    await act(async () => result.window.onVisibleRange(index * size, index * size + 5))
    assert.equal(result.window.getItem(index * size)?.id, index * size + 1)
    assert.ok(result.items.length <= size * 3)
  }
})
