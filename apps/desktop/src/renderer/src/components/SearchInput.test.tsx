import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SearchInput from './SearchInput'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('search input preserves native editing, accessible labels and layout variants', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  let value = ''
  act(() => { renderer = TestRenderer.create(<SearchInput variant="toolbar" withAdornment
    aria-label="查找" value="draft" onChange={event => { value = event.target.value }} />) })
  try {
    const input = renderer.root.findByType('input')
    assert.equal(input.props.type, 'search')
    assert.equal(input.props['aria-label'], '查找')
    assert.equal(input.props['data-adornment'], true)
    input.props.onChange({ target: { value: 'changed' } })
    assert.equal(value, 'changed')
    act(() => renderer.update(<SearchInput variant="compact" fullWidth disabled value="draft" readOnly />))
    const compact = renderer.root.findByType('input')
    assert.equal(compact.props.disabled, true)
    assert.equal(compact.props.value, 'draft')
    assert.equal(compact.props['data-variant'], 'compact')
    assert.equal(compact.props['data-full-width'], true)
  } finally { act(() => renderer.unmount()) }
})
