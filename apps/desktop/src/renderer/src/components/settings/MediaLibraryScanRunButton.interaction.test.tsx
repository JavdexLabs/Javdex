import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import MediaLibraryScanRunButton from './MediaLibraryScanRunButton'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null
const library = { status: 'active' as const, activeRootCount: 1, pendingCleanupJobCount: 0 }

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child as TestRenderer.ReactTestInstance)))
    .join('')
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

it('starts a scan from the settings command and switches the label while running', () => {
  const calls: string[] = []
  const scan = {
    running: false,
    cancelling: false,
    activeRunId: null as string | null,
    start: async () => {
      calls.push('start')
    },
    cancel: async () => {
      calls.push('cancel')
    }
  }
  renderer = TestRenderer.create(
    <MediaLibraryScanRunButton scan={scan} library={library} formDisabled={false} />
  )
  const button = renderer.root.findByType('button')
  assert.equal(button.props['data-ui'], 'button')
  assert.equal(nodeText(button).includes('扫描并导入'), true)
  assert.equal(button.props.disabled, false)
  void act(() => {
    button.props.onClick()
  })
  assert.deepEqual(calls, ['start'])

  renderer.update(
    <MediaLibraryScanRunButton
      scan={{ ...scan, running: true, activeRunId: 'run-1' }}
      library={library}
      formDisabled={false}
    />
  )
  const running = renderer.root.findByType('button')
  assert.equal(nodeText(running).includes('取消扫描'), true)
  void act(() => {
    running.props.onClick()
  })
  assert.deepEqual(calls, ['start', 'cancel'])
})

it('keeps the command disabled without an active source directory', () => {
  renderer = TestRenderer.create(
    <MediaLibraryScanRunButton
      scan={{
        running: false,
        cancelling: false,
        activeRunId: null,
        start: async () => undefined,
        cancel: async () => undefined
      }}
      library={{ ...library, activeRootCount: 0, pendingCleanupJobCount: 0 }}
      formDisabled={false}
    />
  )
  const button = renderer.root.findByType('button')
  assert.equal(button.props.disabled, true)
  assert.equal(button.props.title, '请先添加或启用来源目录')
  assert.equal(nodeText(button).includes('执行待清理'), true)
})
