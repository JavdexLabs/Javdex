import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { SegmentedControl, SegmentedOption } from './SegmentedControl'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('segmented controls expose selection and preserve native button behavior', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  let chosen = false
  act(() => { renderer = TestRenderer.create(<SegmentedControl variant="toolbar" aria-label="性别">
    <SegmentedOption selected>女</SegmentedOption>
    <SegmentedOption selected={false} onClick={() => { chosen = true }}>男</SegmentedOption>
    <SegmentedOption selected={false} disabled>未知</SegmentedOption>
  </SegmentedControl>) })
  try {
    assert.equal(renderer.root.findByType('div').props.role, 'group')
    assert.equal(renderer.root.findByType('div').props['data-variant'], 'toolbar')
    const buttons = renderer.root.findAllByType('button')
    assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [true, false, false])
    assert.ok(buttons.every(button => button.props.type === 'button'))
    assert.equal(buttons[2].props.disabled, true)
    buttons[1].props.onClick()
    assert.equal(chosen, true)
  } finally { act(() => renderer.unmount()) }
})
