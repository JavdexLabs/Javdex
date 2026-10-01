import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer from 'react-test-renderer'
import StatusText from './StatusText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('preserves the requested semantic element and error description id', () => {
  const renderer = TestRenderer.create(<StatusText as="small" tone="danger" id="field-error">名称已存在</StatusText>)
  const text = renderer.root.findByType('small')
  assert.equal(text.props.id, 'field-error')
  assert.deepEqual(text.children, ['名称已存在'])
  renderer.unmount()
})
