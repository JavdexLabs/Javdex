import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Button from './Button'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

function textContent(node: TestRenderer.ReactTestInstance | string): string {
  if (typeof node === 'string') return node
  if (node.props['aria-hidden'] === true || node.props['aria-hidden'] === 'true') return ''
  return node.children.map(textContent).join('')
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('Button', () => {
  it('retains its label and icon through busy cycles without reserving an idle indicator slot', () => {
    const tree = (busy: boolean) => <Button busy={busy}>
      <svg aria-hidden="true"><title>保存图标</title></svg><span>保存</span>
    </Button>
    act(() => { renderer = TestRenderer.create(tree(false)) })
    const idle = renderer!.root.findByType('button')
    const content = idle.children[0] as TestRenderer.ReactTestInstance
    const icon = idle.findByType('svg')
    assert.equal(idle.props['data-busy-slot'], undefined)
    assert.equal(idle.props['aria-busy'], false)
    assert.ok(!idle.props.disabled)
    assert.equal(textContent(idle), '保存')
    assert.equal(content.props['aria-hidden'], undefined)

    act(() => { renderer!.update(tree(true)) })
    const busy = renderer!.root.findByType('button')
    assert.equal(busy.props['data-busy-slot'], undefined)
    assert.equal(busy.props.disabled, true)
    assert.equal(busy.props['aria-busy'], true)
    assert.equal(textContent(busy), '保存')
    assert.equal(busy.children[0], content)
    assert.equal(busy.findByType('svg'), icon)
    assert.equal(content.props['aria-hidden'], undefined)

    act(() => { renderer!.update(tree(false)) })
    assert.ok(!idle.props.disabled)
    assert.equal(idle.props['aria-busy'], false)
    assert.equal(idle.children[0], content)
    assert.equal(idle.findByType('svg'), icon)
    assert.equal(textContent(idle), '保存')
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
    assert.equal(textContent(button), '保存')
    assert.equal(button.props['data-busy-slot'], undefined)
    assert.doesNotMatch(button.props.className, /(?:^| )btn(?: |$)/)
  })

  it('preserves the explicit busy prop priority and caller-controlled disabled state', () => {
    act(() => {
      renderer = TestRenderer.create(<Button busy={false} aria-busy="true" disabled>保存</Button>)
    })
    const button = renderer!.root.findByType('button')
    assert.equal(button.props['aria-busy'], false)
    assert.equal(button.props.disabled, true)

    act(() => { renderer!.update(<Button busy aria-busy="false" disabled={false}>保存</Button>) })
    assert.equal(button.props['aria-busy'], true)
    assert.equal(button.props.disabled, true)

    act(() => { renderer!.update(<Button aria-busy="false" disabled={false}>保存</Button>) })
    assert.equal(button.props['aria-busy'], 'false')
    assert.equal(button.props.disabled, false)
    assert.equal(textContent(button), '保存')
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
    assert.equal(textContent(button), '执行')
    button.props.onClick()
    assert.equal(clicks, 1)
  })
})
