import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Button from './Button'
import GalleryPagination from './GalleryPagination'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => { renderer?.unmount(); renderer = null })

it('keeps gallery page offsets and first/last button eligibility', () => {
  const moves: number[] = []
  const render = (offset: number, loadedCount: number): JSX.Element => (
    <GalleryPagination label="演员写真分页" offset={offset} total={121}
      loadedCount={loadedCount} onMove={next => moves.push(next)} />
  )
  act(() => { renderer = TestRenderer.create(render(0, 60)) })
  const buttons = (): TestRenderer.ReactTestInstance[] => renderer!.root.findAllByType('button')
  assert.equal(renderer!.root.findByType('nav').props['aria-label'], '演员写真分页')
  assert.equal(buttons()[0].props.disabled, true)
  assert.equal(buttons()[1].props.disabled, false)
  act(() => { buttons()[1].props.onClick() })
  act(() => { renderer!.update(render(120, 1)) })
  assert.equal(buttons()[0].props.disabled, false)
  assert.equal(buttons()[1].props.disabled, true)
  act(() => { buttons()[0].props.onClick() })
  assert.deepEqual(moves, [60, 60])
  const summary = renderer!.root.findByType('nav').children[1] as TestRenderer.ReactTestInstance
  assert.equal(summary.children.join(''), '第 3 页 · 共 121 张')
})

it('preserves the compact avatar variant without the total count', () => {
  act(() => {
    renderer = TestRenderer.create(<GalleryPagination label="头像写真分页" offset={60}
      total={121} loadedCount={60} compact hideTotal onMove={() => {}} />)
  })
  assert.equal(renderer!.root.findAllByType(Button).every(button => button.props.size === 'sm'), true)
  assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /共 121 张/)
})

it('does not show pagination for one gallery page', () => {
  act(() => {
    renderer = TestRenderer.create(<GalleryPagination label="写真分页" offset={0}
      total={60} loadedCount={60} onMove={() => assert.fail('one page must not move')} />)
  })
  assert.equal(renderer!.toJSON(), null)
})
