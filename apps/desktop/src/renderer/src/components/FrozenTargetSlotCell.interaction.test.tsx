import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer from 'react-test-renderer'
import FrozenTargetSlotCell from './FrozenTargetSlotCell'
import type { FrozenTargetSlot } from '../query/resolveFrozenTargetSlots'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

it('keeps a deleted frozen id as a placeholder instead of omitting the slot', () => {
  const missing: FrozenTargetSlot<{ id: number }> = { id: 12, status: 'missing' }
  renderer = TestRenderer.create(<FrozenTargetSlotCell slot={missing} />)
  const placeholder = renderer.root.findByProps({ 'aria-label': '已删除' })
  assert.equal(nodeText(placeholder), '已删除')
})

it('renders the ready row and an error slot without collapsing either', () => {
  const ready: FrozenTargetSlot<{ id: number; code: string }> = {
    id: 1,
    status: 'ready',
    value: { id: 1, code: 'M11-001' }
  }
  renderer = TestRenderer.create(
    <FrozenTargetSlotCell slot={ready}>
      <span>M11-001</span>
    </FrozenTargetSlotCell>
  )
  assert.equal(nodeText(renderer.root), 'M11-001')
  const failed: FrozenTargetSlot<{ id: number }> = {
    id: 2,
    status: 'error',
    message: '远程读取失败'
  }
  renderer.update(<FrozenTargetSlotCell slot={failed} />)
  const alert = renderer.root.findByProps({ role: 'alert' })
  assert.equal(nodeText(alert), '远程读取失败')
})
