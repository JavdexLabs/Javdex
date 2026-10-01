/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React, { createRef } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { WebVideo } from '../../../packages/contracts/src/webTypes'
import WebVideoCard from './WebVideoCard'
import WebVideoGrid from './WebVideoGrid'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const film: WebVideo = { id: 1, title: '测试影片', code: 'TEST-1', cover: '/cover',
  releaseDate: '2026-09-30', duration: 610, rating: 4.5 }

test('Web card preserves native anchor props and thumbnail failure fallback', () => {
  const ref = createRef<HTMLAnchorElement>()
  const node = {}
  let clicks = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebVideoCard ref={ref} video={film} href="#/browse/video/1?q=word"
    tabIndex={-1} className="caller-layout" onClick={() => { clicks++ }} />, {
    createNodeMock: element => element.type === 'a' ? node : null
  }) })
  try {
    const anchor = renderer!.root.findByType('a')
    assert.equal(anchor.props.href, '#/browse/video/1?q=word')
    assert.equal(anchor.props.tabIndex, -1)
    assert.equal(anchor.props['data-web-video-card'], 1)
    assert.match(anchor.props.className, /caller-layout/)
    assert.equal(ref.current, node)
    act(() => { anchor.props.onClick() })
    assert.equal(clicks, 1)
    assert.match(renderer!.root.findByType('img').props.src, /size=640/)
    assert.equal(renderer!.root.findByType('img').props.loading, 'lazy')
    assert.equal(renderer!.root.findByType('img').props.alt, '')
    assert.deepEqual(renderer!.root.findByType('p').findAllByType('span').map(span => span.children.join('')), ['2026', '10 分钟', '★ 4.5'])
    act(() => { renderer!.root.findByType('img').props.onError() })
    assert.equal(renderer!.root.findAllByType('img').length, 0)
    assert.equal(renderer!.root.findAllByType('span').filter(span => span.children[0] === film.code).length, 2)
  } finally { act(() => renderer!.unmount()) }
})

test('Web card retains missing year, empty duration and omitted zero rating', () => {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebVideoCard video={{ ...film, cover: null, releaseDate: null, duration: null, rating: 0 }} />) })
  try {
    assert.equal(renderer!.root.findAllByType('img').length, 0)
    const metadata = renderer!.root.findByType('p').findAllByType('span')
    assert.equal(metadata.length, 2)
    assert.equal(metadata[0].children[0], '年份未知')
    assert.equal(metadata[1].children.length, 0)
  } finally { act(() => renderer!.unmount()) }
})

test('Web grid forwards roving focus to native cards and recovers a removed tab stop', () => {
  const videos = [film, { ...film, id: 2 }, { ...film, id: 3 }]
  const renderCard = (video: WebVideo): JSX.Element => <WebVideoCard key={video.id} video={video} href={`#/browse/video/${video.id}`} />
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebVideoGrid videos={videos} renderCard={renderCard} />) })
  try {
    let cards = renderer!.root.findAllByType('a')
    assert.deepEqual(cards.map(card => card.props.tabIndex), [0, -1, -1])
    assert.ok(cards.every(card => card.props['data-navigation-item'] === true))
    act(() => { cards[1].props.onFocus() })
    assert.deepEqual(renderer!.root.findAllByType('a').map(card => card.props.tabIndex), [-1, 0, -1])
    act(() => { renderer!.update(<WebVideoGrid videos={[videos[0], videos[2]]} renderCard={renderCard} />) })
    cards = renderer!.root.findAllByType('a')
    assert.deepEqual(cards.map(card => card.props.tabIndex), [0, -1])
    act(() => { renderer!.update(<WebVideoGrid videos={[]} renderCard={renderCard} />) })
    assert.equal(renderer!.root.findAllByType('a').length, 0)
  } finally { act(() => renderer!.unmount()) }
})
