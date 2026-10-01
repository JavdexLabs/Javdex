/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import WebSearch from './WebSearch'
import WebSidebar from './WebSidebar'
import WebCollectionPicker from './WebCollectionPicker'
import WebLibraryShell from './WebLibraryShell'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const libraries = [{ id: 1, name: '库甲', count: 7 }]
const playlists = [{ id: 2, name: '清单乙', count: 3 }]

test('Web search retains native submission, clear ordering and touch keyboard dismissal', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } })
  const calls: string[] = []
  let blur = 0, prevented = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebSearch value="  term  " onChange={value => calls.push(`change:${value}`)} onSearch={value => calls.push(`search:${value}`)} />) })
  try {
    const input = renderer!.root.findByType('input')
    assert.equal(input.props.type, 'search')
    assert.equal(input.props.enterKeyHint, 'search')
    assert.equal(input.props.maxLength, 200)
    assert.equal(input.props.autoCapitalize, 'none')
    assert.equal(input.props.spellCheck, false)
    act(() => { input.props.onChange({ target: { value: 'new' } }) })
    const submit = renderer!.root.findAllByType('button').find(button => button.props.type === 'submit')!
    assert.equal(submit.props.tabIndex, -1)
    act(() => { renderer!.root.findByType('form').props.onSubmit({ preventDefault: () => { prevented++ },
      currentTarget: { querySelector: () => ({ blur: () => { blur++ } }) } }) })
    act(() => { renderer!.root.findByProps({ 'aria-label': '清除搜索' }).props.onClick() })
    assert.deepEqual(calls, ['change:new', 'search:term', 'change:', 'search:'])
    assert.equal(blur, 1)
    assert.equal(prevented, 1)
  } finally {
    act(() => renderer!.unmount())
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('Web sidebar retains scope URLs and does not highlight all for an unknown library', () => {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebSidebar libraries={libraries} playlists={playlists} library="1" playlist={null} />) })
  try {
    let links = renderer!.root.findAllByType('a')
    assert.deepEqual(links.map(link => link.props.href), ['#/browse', '#/browse?library=1', '#/browse?playlist=2'])
    assert.deepEqual(links.map(link => link.props['data-active']), [false, true, false])
    act(() => { renderer!.update(<WebSidebar libraries={libraries} playlists={playlists} library="unknown" playlist={null} />) })
    links = renderer!.root.findAllByType('a')
    assert.deepEqual(links.map(link => link.props['data-active']), [false, false, false])
    act(() => { renderer!.update(<WebSidebar libraries={libraries} playlists={playlists} library={null} playlist="2" />) })
    assert.deepEqual(renderer!.root.findAllByType('a').map(link => link.props['data-active']), [false, false, true])
  } finally { act(() => renderer!.unmount()) }
})

test('Web range picker closes before selecting and does not navigate an unchanged scope', () => {
  const calls: string[] = []
  const dialog = { showModal: () => calls.push('open'), close: () => calls.push('close'),
    querySelector: () => ({ focus: () => calls.push('focus') }) }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebCollectionPicker libraries={libraries} playlists={playlists}
    currentLibrary={libraries[0]} onSelect={(scope, pointer) => calls.push(`${scope}:${pointer}`)} />, {
    createNodeMock: element => element.type === 'dialog' ? dialog : null
  }) })
  try {
    const button = (attribute: string, value: string): TestRenderer.ReactTestInstance =>
      renderer!.root.findAllByType('button').find(button => button.props[attribute] === value)!
    act(() => { button('aria-label', '选择媒体库或清单').props.onClick() })
    assert.equal(button('data-scope', 'library:1').props['aria-pressed'], true)
    act(() => { button('data-scope', 'library:1').props.onClick({ detail: 1 }) })
    act(() => { button('data-scope', 'playlist:2').props.onClick({ detail: 0 }) })
    act(() => { button('data-scope', 'all').props.onClick({ detail: 1 }) })
    assert.deepEqual(calls, ['open', 'focus', 'close', 'close', 'playlist:2:false', 'close', 'all:true'])
  } finally { act(() => renderer!.unmount()) }
})

test('Web shell retains DOM order, content target and explicit skip/logout commands', () => {
  let skipped = 0, logout = 0, prevented = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebLibraryShell username="viewer" onLogout={() => { logout++ }}
    onSkip={() => { skipped++ }} search={<form />} collection={<><div /><dialog /></>} navigation={<nav />}>内容</WebLibraryShell>) })
  try {
    const root = renderer!.toJSON() as TestRenderer.ReactTestRendererJSON
    assert.deepEqual((root.children as TestRenderer.ReactTestRendererJSON[]).map(child => child.type), ['a', 'header', 'div', 'dialog', 'nav', 'main'])
    assert.equal(renderer!.root.findByType('main').props.id, 'main-content')
    assert.equal(renderer!.root.findByType('main').props['data-navigation-region'], 'content')
    act(() => { renderer!.root.findByProps({ 'data-web-skip': true }).props.onClick({ preventDefault: () => { prevented++ } }) })
    act(() => { renderer!.root.findByType('button').props.onClick() })
    assert.equal(renderer!.root.findByType('button').props['aria-label'], 'viewer，退出登录')
    assert.equal(skipped, 1)
    assert.equal(prevented, 1)
    assert.equal(logout, 1)
  } finally { act(() => renderer!.unmount()) }
})
