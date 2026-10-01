import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ScrapeStatusBadge, { PendingScrapeBadge } from './ScrapeStatusBadge'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('keeps status badge semantics and the pending action', () => {
  let clicked = false
  let renderer: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <div>
        <ScrapeStatusBadge status={0}>未刮削</ScrapeStatusBadge>
        <ScrapeStatusBadge as="dd" status={2}>刮削失败</ScrapeStatusBadge>
        <PendingScrapeBadge onClick={() => { clicked = true }}>查看待确认候选</PendingScrapeBadge>
      </div>
    )
  })

  assert.equal(renderer!.root.findByType('span').props['data-status'], 0)
  assert.equal(renderer!.root.findByType('dd').props['data-status'], 2)
  const pending = renderer!.root.findByType('button')
  assert.equal(pending.props.type, 'button')
  assert.equal(pending.props['data-pending'], 'true')
  act(() => pending.props.onClick())
  assert.equal(clicked, true)
  act(() => renderer!.unmount())
})
