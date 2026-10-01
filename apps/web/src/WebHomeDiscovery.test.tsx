/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import WebHomeDiscovery from './WebHomeDiscovery'
import WebStatus from './WebStatus'
import type { WebVideo } from '../../../packages/contracts/src/webTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('Web status keeps loading neutral and exposes retry errors as alerts', () => {
  let retried = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebStatus error="正在读取…" />) })
  try {
    assert.equal(renderer!.root.findByType('div').props.role, 'status')
    assert.equal(renderer!.root.findAllByType('button').length, 0)
    act(() => { renderer!.update(<WebStatus error="读取失败" retry={() => retried++} />) })
    assert.equal(renderer!.root.findByType('div').props.role, 'alert')
    assert.equal(renderer!.root.findByType('p').children.join(''), '读取失败')
    act(() => { renderer!.root.findByType('button').props.onClick() })
    assert.equal(retried, 1)
  } finally { act(() => renderer!.unmount()) }
})

function fixture(id: number): WebVideo {
  return { id, title: `影片 ${id}`, code: `TEST-${id}`, cover: null, releaseDate: null, duration: null, rating: 0 }
}

function requests(): { pending: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }>; restore: () => void } {
  const previous = globalThis.fetch
  const pending: Array<{ url: string; signal: AbortSignal; resolve: (response: Response) => void }> = []
  globalThis.fetch = (input, init) => new Promise(resolve => {
    pending.push({ url: String(input), signal: init?.signal as AbortSignal, resolve })
  })
  return { pending, restore: () => { globalThis.fetch = previous } }
}

test('Web home retains both grids while refreshing and recovers after errors without duplicate requests', async () => {
  const { pending, restore } = requests()
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let focus = 0
  const logout = { focus: () => { focus++ } }
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    activeElement: logout, querySelector: () => logout
  } })
  let renderer: TestRenderer.ReactTestRenderer
  const renderCard = (video: WebVideo): JSX.Element => <a key={video.id} href={`#/browse/video/${video.id}`}>{video.title}</a>
  const rootProps = { visible: true, renderCard, onUnauthorized: () => assert.fail('not unauthorized') }
  await act(async () => {
    renderer = TestRenderer.create(<WebHomeDiscovery {...rootProps} />, {
      createNodeMock: element => element.props['data-web-home'] !== undefined
        ? { querySelector: () => ({ focus: () => { focus++ } }) } : null
    })
  })
  try {
    assert.equal(pending.length, 1)
    assert.match(pending[0].url, /^\/api\/home\?seed=/)
    assert.equal(renderer!.root.findByProps({ 'data-web-home': true }).props['aria-busy'], true)
    await act(async () => { pending[0].resolve(Response.json({ discovery: [fixture(1)], recent: [fixture(2)] })) })
    assert.deepEqual(renderer!.root.findAllByType('a').map(link => link.props.href), ['#/browse/video/1', '#/browse?sort=recent', '#/browse/video/2'])
    act(() => { renderer!.root.findByType('button').props.onClick() })
    assert.equal(pending.length, 2)
    assert.equal(pending[0].signal.aborted, true)
    assert.equal(renderer!.root.findByType('button').props['aria-disabled'], true)
    act(() => { renderer!.root.findByType('button').props.onClick() })
    assert.equal(pending.length, 2, 'busy refresh ignores repeated activation')
    assert.equal(renderer!.root.findAllByType('a').length, 3, 'refresh does not unload existing grids')
    await act(async () => { pending[1].resolve(Response.json({ error: '合成失败' }, { status: 503 })) })
    assert.equal(renderer!.root.findByProps({ role: 'alert' }).findByType('p').children.join(''), '合成失败')
    assert.equal(renderer!.root.findAllByType('a').length, 3)
    act(() => { renderer!.root.findByProps({ role: 'alert' }).findByType('button').props.onClick() })
    assert.equal(pending.length, 3)
    await act(async () => { pending[2].resolve(Response.json({ discovery: [], recent: [] })) })
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    assert.equal(focus, 2, 'retry moves to logout during loading and restores an actionable home control')
    act(() => { renderer!.update(<WebHomeDiscovery {...rootProps} visible={false} />) })
    assert.equal(renderer!.root.findByProps({ 'data-web-home': true }).props.hidden, true)
    assert.equal(pending.length, 3, 'hiding for detail does not reload home')
  } finally {
    act(() => renderer!.unmount())
    restore()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
  }
})

test('Web home forwards unauthorized and aborts on unmount without accepting late results', async () => {
  const { pending, restore } = requests()
  let unauthorized = 0
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<WebHomeDiscovery visible renderCard={() => <a />} onUnauthorized={() => unauthorized++} />) })
  try {
    await act(async () => { pending[0].resolve(Response.json({ error: '过期' }, { status: 401 })) })
    assert.equal(unauthorized, 1)
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
    act(() => renderer!.unmount())
    assert.equal(pending[0].signal.aborted, true)
    await act(async () => { renderer = TestRenderer.create(<WebHomeDiscovery visible renderCard={() => <a />} onUnauthorized={() => unauthorized++} />) })
    act(() => renderer!.unmount())
    assert.equal(pending[1].signal.aborted, true)
    await act(async () => { pending[1].resolve(Response.json({ error: '迟到结果' }, { status: 401 })) })
    assert.equal(unauthorized, 1)
  } finally { restore() }
})
