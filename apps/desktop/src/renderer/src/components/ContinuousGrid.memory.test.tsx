import { continuousViewport } from '../test/continuousViewport'
import ContinuousGrid from './ContinuousGrid'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ContinuousWindow } from '../hooks/useContinuousPage'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

function windowFor(total: number): ContinuousWindow<{ id: number }> {
  return {
    total,
    getItem: index => ({ id: index + 1 }),
    findIndex: () => -1,
    onVisibleRange: () => {},
    retry: () => {},
    error: null,
    loading: false
  }
}

let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined })

it('ignores session memory from a different URL page', async () => {
  const viewport = continuousViewport()
  const data = windowFor(200)
  const grid = (initialIndex: number) => (
    <ContinuousGrid window={data} scope="list" pageSize={60} initialIndex={initialIndex} label="list"
      itemKey={item => item.id} itemHeight={64} renderItem={() => <span />} />
  )
  await act(async () => { renderer = TestRenderer.create(grid(180), { createNodeMock: viewport.createNodeMock }) })
  await viewport.scroll(renderer!, 180)
  assert.ok(viewport.owner.scrollTop > 0)
  await act(async () => renderer!.unmount())
  await act(async () => { renderer = TestRenderer.create(grid(0), { createNodeMock: viewport.createNodeMock }) })
  assert.equal(viewport.owner.scrollTop, 0)
})

for (const minWidth of [120, 38]) it(`does not publish a restored row preceding the URL page boundary until user scrolls (minWidth=${minWidth})`, async () => {
  const viewport = continuousViewport()
  const data = windowFor(200)
  const anchors: number[] = []
  const listeners = new Set<() => void>()
  let top = 0
  Object.defineProperty(viewport.owner, 'scrollTop', {
    get: () => top,
    set: (value: number) => { top = Math.round(value) }
  })
  viewport.owner.addEventListener = (_: string, listener: () => void) => listeners.add(listener)
  viewport.owner.removeEventListener = (_: string, listener: () => void) => listeners.delete(listener)
  // Three columns exercise pixel rounding; eight columns straddle the 60-item page.
  await act(async () => { renderer = TestRenderer.create(
    <ContinuousGrid window={data} scope="fractional" pageSize={60} initialIndex={60} label="list"
      minWidth={minWidth} itemKey={item => item.id} itemHeight={width => width * 1.7}
      renderItem={() => <span />} onAnchor={index => anchors.push(index)} />,
    { createNodeMock: viewport.createNodeMock }) })
  await act(async () => { for (const listener of listeners) listener() })
  assert.deepEqual(anchors, [], 'Restoration must not reset the URL page')
  top += 500
  await act(async () => { for (const listener of listeners) listener() })
  assert.equal(anchors.length, 1, 'Real scrolling still publishes an anchor')
  assert.ok(anchors[0] >= 60)
})
