/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { WebResource } from '../../../packages/contracts/src/webTypes'
import ResourceList from './ResourceCard'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const defaults: WebResource = { id: 0, libraryId: 1, name: '', libraryName: null, kind: 'local',
  playable: false, isPrimary: false, mime: null, reason: null, format: null,
  sizeBytes: null, durationSeconds: null, downloadUrl: null, link: null }
const resources: WebResource[] = [
  { ...defaults, id: 1, name: '同名资源', libraryName: '甲', kind: 'local', playable: true, isPrimary: true,
    mime: 'video/mp4', reason: null, sizeBytes: 2147483648, durationSeconds: 120 },
  { ...defaults, id: 2, name: '同名资源', libraryName: '乙', kind: 'local', playable: false, isPrimary: false,
    mime: null, reason: '浏览器不支持此格式', downloadUrl: '/download/2' },
  { ...defaults, id: 3, name: '网页资源', kind: 'web', playable: false, isPrimary: false,
    mime: null, reason: null, link: 'https://example.com/watch' }
]

test('resource list retains selection, native commands and explicit playback IDs', () => {
  const played: number[] = []
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<ResourceList resources={resources} selected={1} play={id => played.push(id)} />) })
  try {
    const cards = renderer!.root.findAllByType('article')
    assert.deepEqual(cards.map(card => card.props['data-selected']), [true, false, false])
    const play = cards[0].findByType('button')
    assert.equal(play.props['aria-pressed'], true)
    act(() => { play.props.onClick() })
    assert.deepEqual(played, [1])
    act(() => { renderer!.update(<ResourceList resources={resources} selected={null} play={id => played.push(id)} />) })
    assert.deepEqual(renderer!.root.findAllByType('article').map(card => card.props['data-selected']), [false, false, false])
    const metadata = renderer!.root.findAllByType('small').map(node => node.children.join(''))
    assert.match(metadata[0], /2\.0 GB · 2 分钟 · 甲/)
    assert.match(metadata[1], /乙/)
    const download = cards[1].findByType('a')
    assert.equal(download.props.href, '/download/2')
    assert.equal(download.props.download, true)
    const external = cards[2].findByType('a')
    assert.equal(external.props.href, resources[2].link)
    assert.equal(external.props.target, '_blank')
    assert.equal(external.props.rel, 'noopener noreferrer')
  } finally {
    act(() => renderer!.unmount())
  }
})

test('resource explanations share one status and closing restores the current opener', () => {
  let renderer: TestRenderer.ReactTestRenderer
  let focusCount = 0
  const opener = { isConnected: true, focus: () => { focusCount++ } }
  act(() => { renderer = TestRenderer.create(<ResourceList resources={resources} selected={null} play={() => {}} />) })
  try {
    const cards = renderer!.root.findAllByType('article')
    act(() => { cards[1].findByType('button').props.onClick({ currentTarget: opener }) })
    assert.equal(renderer!.root.findAllByProps({ role: 'status' }).length, 1)
    assert.equal(renderer!.root.findByProps({ role: 'status' }).findByType('span').children[0], resources[1].reason)
    act(() => { cards[2].findAllByType('button')[0].props.onClick({ currentTarget: opener }) })
    assert.equal(renderer!.root.findAllByProps({ role: 'status' }).length, 1)
    assert.equal(renderer!.root.findByProps({ role: 'status' }).findByType('span').children[0], '此资源暂不可用，请在桌面端检查资源。')
    act(() => { renderer!.root.findByProps({ 'aria-label': '关闭资源提示' }).props.onClick() })
    assert.equal(focusCount, 1)
    assert.equal(renderer!.root.findAllByProps({ role: 'status' }).length, 0)
  } finally {
    act(() => renderer!.unmount())
  }
})
