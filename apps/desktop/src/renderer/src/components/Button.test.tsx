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
  })
})
