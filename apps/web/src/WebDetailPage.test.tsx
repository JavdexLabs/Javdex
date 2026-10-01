/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { WebDetail, WebResource } from '../../../packages/contracts/src/webTypes'
import WebDetailPage from './WebDetailPage'
import WebCastMember from './WebCastMember'
import WebText from './WebText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('Web text forwards native paragraph attributes, content, events and ref without leaking tone', () => {
  const ref = React.createRef<HTMLParagraphElement>(), node = { name: 'native paragraph' }
  let clicks = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebText ref={ref} tone="danger" className="caller-layout" role="alert"
    aria-live="polite" onClick={() => clicks++}>原始错误</WebText>, { createNodeMock: () => node }) })
  try {
    const paragraph = renderer!.root.findByType('p')
    assert.equal(paragraph.props.role, 'alert')
    assert.equal(paragraph.props['aria-live'], 'polite')
    assert.equal(paragraph.props.tone, undefined)
    assert.match(paragraph.props.className, /caller-layout/)
    assert.equal(paragraph.children.join(''), '原始错误')
    assert.equal(ref.current, node)
    act(() => { paragraph.props.onClick() })
    assert.equal(clicks, 1)
  } finally { act(() => renderer!.unmount()) }
})

test('Web cast retains encoded scope links, thumbnail loading and all gender fallbacks', () => {
  const actress = { id: 1, name: '演员 & 长名称', gender: 'female' as const, avatar: '/image/avatar' }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebCastMember actress={actress} />) })
  try {
    const link = renderer!.root.findByType('a')
    assert.equal(link.props.href, '#/browse?actress=1&label=%E6%BC%94%E5%91%98+%26+%E9%95%BF%E5%90%8D%E7%A7%B0')
    const image = renderer!.root.findByType('img')
    assert.equal(image.props.loading, 'lazy')
    assert.equal(image.props.decoding, 'async')
    assert.equal(image.props.alt, '')
    assert.match(image.props.src, /320/)
    act(() => { image.props.onError() })
    assert.equal(renderer!.root.findAllByType('img').length, 0)
    assert.equal(renderer!.root.findAllByType('span').at(-1)!.children.join(''), '♀ 女')
    act(() => { renderer!.update(<WebCastMember actress={{ ...actress, gender: 'male', avatar: null }} />) })
    assert.equal(renderer!.root.findAllByType('span').at(-1)!.children.join(''), '♂ 男')
    act(() => { renderer!.update(<WebCastMember actress={{ ...actress, gender: null, avatar: null }} />) })
    assert.equal(renderer!.root.findAllByType('span').at(-1)!.children.join(''), '性别未知')
  } finally { act(() => renderer!.unmount()) }
})

const resource: WebResource = { id: 1, libraryId: 1, isPrimary: false, name: '备用资源', kind: 'local',
  playable: true, reason: null, mime: 'video/mp4', format: 'MP4', sizeBytes: null, durationSeconds: null,
  libraryName: null, downloadUrl: null, link: null }
const film: WebDetail = { id: 17, code: 'TEST-17', title: '合成影片', cover: null, releaseDate: null, duration: null,
  rating: 0, summary: null, maker: null, publisher: null, series: null, director: null,
  actresses: [], tags: [], images: [], resources: [resource,
    { ...resource, id: 2, isPrimary: true, playable: false, name: '不可播放主资源', reason: '格式不支持' },
    { ...resource, id: 3, libraryId: 2, isPrimary: true, name: '其他库主资源' }] }

function environment() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousFetch = globalThis.fetch
  const pending: Array<{ signal: AbortSignal; resolve: (response: Response) => void }> = []
  const counts = { focus: 0, retryFocus: 0, load: 0, play: 0, unauthorized: 0 }
  const documentStub = { title: '', activeElement: null as unknown, body: {}, querySelector: () => retry }
  const back = { focus: () => { counts.focus++; documentStub.activeElement = back } }
  const retry = { focus: () => { counts.retryFocus++; documentStub.activeElement = retry } }
  const location = { hash: '' }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location, history: { state: null }, addEventListener: () => {}, removeEventListener: () => {}
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub })
  globalThis.fetch = (_input, init) => new Promise(resolve => pending.push({ signal: init?.signal as AbortSignal, resolve }))
  return { pending, counts, location, documentStub,
    onUnauthorized: () => { counts.unauthorized++ },
    createNodeMock: (element: React.ReactElement) => element.props.id === 'detail-back' ? back
      : element.type === 'video' ? { load: () => counts.load++, play: () => { counts.play++; return Promise.resolve() } } : null,
    restore: () => {
      globalThis.fetch = previousFetch
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

test('Web detail keeps library primary isolation and explicit playback controlled by URL', async () => {
  const env = environment()
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<WebDetailPage id={17} query={new URLSearchParams('library=1')} onUnauthorized={env.onUnauthorized} />, { createNodeMock: env.createNodeMock }) })
  try {
    assert.equal(env.counts.focus, 1)
    await act(async () => { env.pending[0].resolve(Response.json(film)) })
    assert.equal(renderer!.root.findAllByType('video').length, 0, 'unplayable primary does not choose another library or backup')
    act(() => { renderer!.update(<WebDetailPage id={17} query={new URLSearchParams('library=2')} onUnauthorized={env.onUnauthorized} />) })
    assert.equal(renderer!.root.findByType('video').props.src, '/api/videos/17/media/3')
    assert.equal(renderer!.root.findByType('video').props.autoPlay, false)
    assert.equal(renderer!.root.findByType('video').props.preload, 'metadata')
    assert.equal(renderer!.root.findByType('video').props.playsInline, true)
    act(() => { renderer!.update(<WebDetailPage id={17} query={new URLSearchParams('library=1&play=1&sort=code')} onUnauthorized={env.onUnauthorized} />) })
    assert.equal(renderer!.root.findByType('video').props.src, '/api/videos/17/media/1')
    assert.equal(renderer!.root.findByType('video').props.autoPlay, false)
    act(() => { renderer!.root.findAllByType('article')[2].findByType('button').props.onClick() })
    assert.equal(env.location.hash, '#/browse/video/17?library=1&play=3&sort=code')
    act(() => { renderer!.root.findByProps({ id: 'detail-back' }).props.onClick() })
    assert.equal(env.location.hash, '#/browse?library=1&sort=code', 'back removes only playback scope')
    assert.equal(env.pending.length, 1, 'query-only selection does not refetch the detail')
    assert.equal(env.documentStub.title, '合成影片 · Javdex')
  } finally { act(() => renderer!.unmount()); env.restore() }
})

test('Web detail playback error offers native retry without changing selected resource', async () => {
  const env = environment()
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<WebDetailPage id={17} query={new URLSearchParams('play=1')} onUnauthorized={env.onUnauthorized} />, { createNodeMock: env.createNodeMock }) })
  try {
    await act(async () => { env.pending[0].resolve(Response.json(film)) })
    act(() => { renderer!.root.findByType('video').props.onError() })
    assert.equal(renderer!.root.findByType('video').props.hidden, true)
    assert.equal(renderer!.root.findByProps({ 'data-web-player-error': true }).props.role, 'alert')
    const retry = renderer!.root.findAllByType('button').find(button => button.children.includes('重试播放'))!
    act(() => { retry.props.onClick() })
    assert.equal(env.counts.load, 1)
    assert.equal(env.counts.focus, 2)
    assert.equal(renderer!.root.findByType('video').props.src, '/api/videos/17/media/1')
    assert.equal(renderer!.root.findAllByProps({ 'data-web-player-fallback': true }).length, 0)
  } finally { act(() => renderer!.unmount()); env.restore() }
})

test('Web detail read retry preserves its actionable focus and aborts its request on unmount', async () => {
  const env = environment()
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<WebDetailPage id={17} query={new URLSearchParams()} onUnauthorized={env.onUnauthorized} />, { createNodeMock: env.createNodeMock }) })
  try {
    await act(async () => { env.pending[0].resolve(Response.json({ error: '读取失败' }, { status: 503 })) })
    assert.equal(env.counts.retryFocus, 1)
    act(() => { renderer!.root.findByProps({ role: 'alert' }).findByType('button').props.onClick() })
    assert.equal(env.counts.focus, 2)
    assert.equal(env.pending[0].signal.aborted, true)
    assert.equal(env.pending.length, 2)
    await act(async () => { env.pending[1].resolve(Response.json(film)) })
    assert.equal(renderer!.root.findByType('h1').children.join(''), film.title)
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
  } finally {
    act(() => renderer!.unmount())
    assert.equal(env.pending.at(-1)!.signal.aborted, true)
    env.restore()
  }
})

test('Web detail forwards unauthorized without replacing it with an ordinary read error', async () => {
  const env = environment()
  let renderer: TestRenderer.ReactTestRenderer
  await act(async () => { renderer = TestRenderer.create(<WebDetailPage id={17} query={new URLSearchParams()} onUnauthorized={env.onUnauthorized} />, { createNodeMock: env.createNodeMock }) })
  try {
    await act(async () => { env.pending[0].resolve(Response.json({ error: '会话过期' }, { status: 401 })) })
    assert.equal(env.counts.unauthorized, 1)
    assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
  } finally { act(() => renderer!.unmount()); env.restore() }
})
