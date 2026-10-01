import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { SegmentedActions, SegmentedAction } from './SegmentedActions'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

test('segmented commands retain native props, ref and layout without implicit toggle state', () => {
  const ref = React.createRef<HTMLButtonElement>()
  const element = { focus() {} }
  let clicks = 0
  act(() => {
    renderer = TestRenderer.create(<SegmentedActions size="sm" aria-label="字段动作" className="layout">
      <SegmentedAction ref={ref} onClick={() => { clicks++ }}>全选</SegmentedAction>
      <SegmentedAction disabled type="submit" title="不可执行">清空</SegmentedAction>
    </SegmentedActions>, { createNodeMock: node => node.type === 'button' ? element : null })
  })
  const group = renderer!.root.findByProps({ role: 'group' })
  assert.equal(group.props['aria-label'], '字段动作')
  assert.equal(group.props['data-size'], 'sm')
  assert.match(group.props.className, /(?:^| )layout(?: |$)/)
  assert.doesNotMatch(group.props.className, /btn-segment/)
  const [select, clear] = renderer!.root.findAllByType('button')
  assert.equal(ref.current, element)
  assert.equal(select.props.type, 'button')
  assert.equal(select.props['aria-pressed'], undefined)
  select.props.onClick()
  assert.equal(clicks, 1)
  assert.equal(clear.props.type, 'submit')
  assert.equal(clear.props.disabled, true)
  assert.equal(clear.props.title, '不可执行')
})

test('segmented toggles use caller-provided pressed state without imposing radio behavior', () => {
  act(() => { renderer = TestRenderer.create(<SegmentedActions>
    <SegmentedAction aria-pressed={true}>不限</SegmentedAction>
    <SegmentedAction aria-pressed={false}>缺任一字段</SegmentedAction>
  </SegmentedActions>) })
  const buttons = renderer!.root.findAllByType('button')
  assert.deepEqual(buttons.map(button => button.props['aria-pressed']), [true, false])
  assert.ok(buttons.every(button => button.props.role === undefined && button.props.tabIndex === undefined))
})
