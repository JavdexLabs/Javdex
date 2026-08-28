import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { AgentMetadataSnapshot } from '@shared/agentMetadataTypes'
import AgentMetadataActivityFeed from './AgentMetadataActivityFeed'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function snapshot(): AgentMetadataSnapshot {
  return {
    runId: 'run-1',
    revision: 2,
    cursor: 0,
    target: { kind: 'video', id: 355 },
    phase: 'collecting',
    summary: 'Agent 正在读取外部详情页',
    source: {
      requestedUrl: 'https://example.test/detail',
      displayUrl: 'https://example.test/detail'
    },
    activities: [
      {
        id: 'reasoning:1',
        kind: 'reasoning',
        status: 'running',
        turn: 1,
        text: '先核对番号，再读取字段。',
        charCount: 13,
        truncated: false
      },
      {
        id: 'action:1',
        kind: 'action',
        status: 'success',
        tool: 'browser',
        label: '打开目标详情页',
        summary: '已打开目标详情页'
      }
    ]
  }
}

describe('AgentMetadataActivityFeed', () => {
  it('keeps live model thinking open and shows semantic actions', () => {
    act(() => {
      renderer = TestRenderer.create(<AgentMetadataActivityFeed snapshot={snapshot()} />)
    })

    assert.ok(renderer)
    assert.equal(renderer.root.findByType('details').props.open, true)
    assert.equal(
      renderer.root.findAllByType('div').some((node) =>
        node.children.includes('先核对番号，再读取字段。')
      ),
      true
    )
    assert.equal(
      renderer.root.findAllByType('strong').some((node) => node.children.includes('打开目标详情页')),
      true
    )
    assert.equal(
      renderer.root.findAllByType('span').some((node) => node.children.includes('已完成')),
      true
    )
  })

  it('collapses completed thinking into an expandable preview', () => {
    const value = snapshot()
    const reasoning = value.activities[0]
    if (reasoning?.kind === 'reasoning') reasoning.status = 'success'
    act(() => {
      renderer = TestRenderer.create(<AgentMetadataActivityFeed snapshot={value} />)
    })

    assert.ok(renderer)
    assert.notEqual(renderer.root.findByType('details').props.open, true)
    assert.equal(
      renderer.root.findAllByType('span').some((node) =>
        node.children.includes('先核对番号，再读取字段。')
      ),
      true
    )

    act(() => {
      renderer?.root.findByType('details').props.onToggle({ currentTarget: { open: true } })
    })

    assert.equal(renderer.root.findByType('details').props.open, true)
  })

  it('moves a finished live thought back into collapsed history', () => {
    const value = snapshot()
    act(() => {
      renderer = TestRenderer.create(<AgentMetadataActivityFeed snapshot={value} />)
    })

    const completed = snapshot()
    const reasoning = completed.activities[0]
    if (reasoning?.kind === 'reasoning') reasoning.status = 'success'
    act(() => {
      renderer?.update(<AgentMetadataActivityFeed snapshot={completed} />)
    })

    assert.ok(renderer)
    assert.equal(renderer.root.findByType('details').props.open, false)
  })
})
