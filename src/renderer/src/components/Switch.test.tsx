import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Switch from './Switch'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('Switch', () => {
  it('loads its CSS Module and preserves native checkbox semantics', () => {
    act(() => {
      renderer = TestRenderer.create(
        <Switch aria-label="启用功能" checked disabled readOnly />
      )
    })

    const input = renderer?.root.findByType('input')
    assert.ok(input)
    assert.equal(input.props.type, 'checkbox')
    assert.equal(input.props.role, 'switch')
    assert.equal(input.props['aria-label'], '启用功能')
    assert.equal(input.props.checked, true)
    assert.equal(input.props.disabled, true)
  })
})
