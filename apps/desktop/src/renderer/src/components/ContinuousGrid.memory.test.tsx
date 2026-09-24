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
