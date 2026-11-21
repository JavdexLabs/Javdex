import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import GalleryPagination from './GalleryPagination'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => { renderer?.unmount(); renderer = null })

it('does not show pagination for one gallery page', () => {
  act(() => {
    renderer = TestRenderer.create(<GalleryPagination label="写真分页" offset={0}
      total={60} loadedCount={60} onMove={() => assert.fail('one page must not move')} />)
  })
  assert.equal(renderer!.toJSON(), null)
})
