import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ResultCount from './ResultCount'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('result counts preserve content and live semantics through width variants without global classes', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ResultCount width="media" aria-live="polite">共 12 部</ResultCount>) })
  try {
    const span = renderer.root.findByType('span')
    assert.equal(span.props['aria-live'], 'polite')
    assert.equal(span.props['data-width'], 'media')
    assert.equal(span.props['data-stable'], true)
    assert.equal(span.children.join(''), '共 12 部')
    assert.doesNotMatch(span.props.className, /count-badge/)
    act(() => renderer.update(<ResultCount stable={false}>12</ResultCount>))
    assert.equal(renderer.root.findByType('span').props['data-stable'], undefined)
  } finally { act(() => renderer.unmount()) }
})
