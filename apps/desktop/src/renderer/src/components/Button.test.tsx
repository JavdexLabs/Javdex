import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Button from './Button'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('Button', () => {
  it('keeps the accessible label and indicator slot stable while busy', () => {
    act(() => { renderer = TestRenderer.create(<Button busy={false}>保存</Button>) })
    const idle = renderer!.root.findByType('button')
    assert.equal(idle.props['data-busy-slot'], true)
    assert.equal(idle.children.join(''), '保存')
    act(() => { renderer!.update(<Button busy>保存</Button>) })
    const busy = renderer!.root.findByType('button')
    assert.equal(busy.props['data-busy-slot'], true)
    assert.equal(busy.props.disabled, true)
    assert.equal(busy.props['aria-busy'], true)
    assert.equal(busy.children.join(''), '保存')
  })
  it('loads its CSS Module and preserves native button semantics', () => {
    act(() => {
      renderer = TestRenderer.create(
        <Button variant="primary" size="sm" disabled aria-busy="true">
          保存
        </Button>
      )
    })

    const button = renderer?.root.findByType('button')
    assert.ok(button)
    assert.equal(button.props.type, 'button')
    assert.equal(button.props['data-ui'], 'button')
    assert.equal(button.props.disabled, true)
    assert.equal(button.props['aria-busy'], 'true')
    assert.doesNotMatch(button.props.className, /(?:^| )btn(?: |$)/)
  })

  it('retains caller layout, ref and click without a global visual class', () => {
    const ref = React.createRef<HTMLButtonElement>()
    const node = { focus: () => {} }
    let clicks = 0
    act(() => {
      renderer = TestRenderer.create(<Button ref={ref} className="caller-layout" type="submit"
        onClick={() => { clicks++ }}>执行</Button>,
      { createNodeMock: element => element.type === 'button' ? node : null })
    })
    const button = renderer!.root.findByType('button')
    assert.equal(ref.current, node)
    assert.equal(button.props.type, 'submit')
    assert.match(button.props.className, /(?:^| )caller-layout(?: |$)/)
    assert.doesNotMatch(button.props.className, /(?:^| )btn(?: |$)/)
    button.props.onClick()
    assert.equal(clicks, 1)
  })
})
