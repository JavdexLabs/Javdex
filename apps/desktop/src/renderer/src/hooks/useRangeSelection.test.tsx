import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { useRangeSelection, type SelectionWindow } from './useRangeSelection'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
type Item = { id: number; title?: string }
let renderer: TestRenderer.ReactTestRenderer | undefined
let current!: ReturnType<typeof useRangeSelection<Item>>
afterEach(() => { act(() => renderer?.unmount()) })
function Harness(props: { items: Item[]; scope?: string; window?: SelectionWindow<Item>; onError?: (e: unknown) => void }): null {
  current = useRangeSelection(props.items, props.scope ?? 'A', { window: props.window, onError: props.onError })
  return null
}
const shift = { shiftKey: true, preventDefault() {} }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const rows = Array.from({ length: 605 }, (_, i) => ({ id: i + 1, title: 'wide '.repeat(100) }))

test('resident eviction preserves compact selected identities and absolute cross-page range', async () => {
  const calls: number[][] = []
  const window: SelectionWindow<Item> = { total: rows.length, getItem: i => rows[i],
    readRange: async (start, end) => { calls.push([start, end]); return rows.slice(start, end) } }
  act(() => { renderer = TestRenderer.create(<Harness items={rows.slice(0, 60)} window={window} />) })
  act(() => current.toggleSelection(rows[3], 3))
  act(() => renderer!.update(<Harness items={rows.slice(600)} window={window} />))
  assert.deepEqual(current.selectedItems, [{ id: 4 }])
  await act(async () => current.toggleSelection(rows[602], 602, shift))
  assert.deepEqual(calls, [[3, 603]])
  assert.equal(current.selectedCount, 600)
  assert.deepEqual(current.selectedItems.at(-1), { id: 603 })
})

test('failed, truncated, reordered and duplicate ranges never partially commit', async () => {
  const errors: unknown[] = []
  for (const result of [new Error('offline'), [{ id: 1 }], [{ id: 2 }, { id: 1 }, { id: 3 }], [{ id: 1 }, { id: 1 }, { id: 3 }]]) {
    const window: SelectionWindow<Item> = { total: 3, getItem: i => rows[i], readRange: async () => {
      if (result instanceof Error) throw result
      return result
    } }
    act(() => { renderer?.unmount(); renderer = TestRenderer.create(<Harness items={rows.slice(0, 3)} window={window} onError={e => errors.push(e)} />) })
    act(() => current.toggleSelection(rows[0], 0))
    await act(async () => current.toggleSelection(rows[2], 2, shift))
    assert.deepEqual([...current.selectedIds], [1])
  }
  assert.equal(errors.length, 4)
})

test('ABA navigation cancels held range and does not revive old selection or error', async () => {
  const held = deferred<Item[]>()
  const errors: unknown[] = []
  let signal: AbortSignal | undefined
  const window: SelectionWindow<Item> = { total: 3, getItem: i => rows[i], readRange: (_s, _e, s) => { signal = s; return held.promise } }
  const render = (scope: string) => <Harness scope={scope} items={rows.slice(0, 3)} window={window} onError={e => errors.push(e)} />
  act(() => { renderer = TestRenderer.create(render('A')) })
  act(() => current.toggleSelection(rows[0], 0))
  await act(async () => current.toggleSelection(rows[2], 2, shift))
  act(() => renderer!.update(render('B')))
  act(() => renderer!.update(render('A')))
  act(() => current.toggleSelection(rows[1], 1))
  await act(async () => held.reject(new Error('old failure')))
  assert.equal(signal?.aborted, true)
  assert.deepEqual([...current.selectedIds], [2])
  assert.equal(errors.length, 0)
})

test('replacement ranges serialize reads, discard queued gestures and commit only latest', async () => {
  const held = deferred<Item[]>()
  const ends: number[] = []
  const window: SelectionWindow<Item> = { total: 5, getItem: i => rows[i], readRange: async (start, end) => {
    ends.push(end)
    return ends.length === 1 ? held.promise : rows.slice(start, end)
  } }
  act(() => { renderer = TestRenderer.create(<Harness items={rows.slice(0, 5)} window={window} />) })
  act(() => current.toggleSelection(rows[0], 0))
  await act(async () => current.toggleSelection(rows[2], 2, shift))
  act(() => current.toggleSelection(rows[3], 3, shift))
  act(() => current.toggleSelection(rows[4], 4, shift))
  assert.deepEqual(ends, [3])
  await act(async () => held.resolve(rows.slice(0, 3)))
  assert.deepEqual(ends, [3, 5])
  assert.equal(current.selectedCount, 5)
})

test('clear and single toggle cancel held ranges; detailed arrays remain supported', async () => {
  act(() => { renderer = TestRenderer.create(<Harness items={rows.slice(0, 4)} />) })
  act(() => current.toggleSelection(rows[3], 3))
  await act(async () => current.toggleSelection(rows[1], 1, shift))
  assert.deepEqual([...current.selectedIds], [4, 2, 3])
  act(() => current.toggleSelection(rows[2], 2))
  assert.deepEqual([...current.selectedIds], [4, 2])
  act(() => current.clearSelection())
  assert.equal(current.selectedCount, 0)
})

test('held range exposes busy, clear cancels it, and current failures expose error', async () => {
  const held = deferred<Item[]>()
  let signal: AbortSignal | undefined
  const window: SelectionWindow<Item> = { total: 3, getItem: i => rows[i], readRange: (_s, _e, s) => { signal = s; return held.promise } }
  act(() => { renderer = TestRenderer.create(<Harness items={rows.slice(0, 3)} window={window} />) })
  act(() => current.toggleSelection(rows[0], 0))
  await act(async () => current.toggleSelection(rows[2], 2, shift))
  assert.equal(current.selectingRange, true)
  act(() => current.clearSelection())
  assert.equal(current.selectingRange, false)
  assert.equal(signal?.aborted, true)
  await act(async () => held.resolve(rows.slice(0, 3)))
  assert.equal(current.selectedCount, 0)
  const failed = { ...window, readRange: async () => { throw new Error('range unavailable') } }
  act(() => renderer!.update(<Harness items={rows.slice(0, 3)} window={failed} />))
  act(() => current.toggleSelection(rows[0], 0))
  await act(async () => current.toggleSelection(rows[2], 2, shift))
  assert.equal(current.selectingRange, false)
  assert.equal(current.selectionError, 'range unavailable')
  assert.deepEqual([...current.selectedIds], [1])
})
