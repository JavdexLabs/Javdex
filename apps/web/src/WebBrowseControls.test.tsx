/// <reference types="node" />

import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import WebBrowseHeading from './WebBrowseHeading'
import WebBrowseSort from './WebBrowseSort'
import WebChipRow from './WebChipRow'
import WebPagination from './WebPagination'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

test('Web browse heading distinguishes loading, zero and search description', () => {
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebBrowseHeading title="长媒体库名" search={null} total={null} />) })
  try {
    assert.equal(renderer!.root.findByType('span').children.join(''), '— 部影片')
    assert.equal(renderer!.root.findByType('h1').children.join(''), '长媒体库名')
    act(() => { renderer!.update(<WebBrowseHeading title="搜索结果" search="番号" total={0} />) })
    assert.equal(renderer!.root.findByType('span').children.join(''), '0 部影片')
    assert.equal(renderer!.root.findAllByType('p')[1].children.join(''), '“番号” 的匹配影片')
    act(() => { renderer!.update(<WebBrowseHeading title="搜索结果" search="" total={12345} />) })
    assert.equal(renderer!.root.findByType('span').children.join(''), `${(12345).toLocaleString()} 部影片`)
  } finally { act(() => renderer!.unmount()) }
})

test('Web sort retains default and unknown selection without invoking navigation', () => {
  const values: string[] = []
  const onChange = (value: string): void => { values.push(value) }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebBrowseSort value={null} onChange={onChange} />) })
  try {
    assert.deepEqual(renderer!.root.findAllByType('button').map(button => button.props['aria-pressed']), [true, false, false, false])
    act(() => { renderer!.root.findAllByType('button')[3].props.onClick() })
    assert.deepEqual(values, ['code'])
    act(() => { renderer!.update(<WebBrowseSort value="unknown" onChange={onChange} />) })
    assert.deepEqual(renderer!.root.findAllByType('button').map(button => button.props['aria-pressed']), [false, false, false, false])
    assert.deepEqual(values, ['code'], 'receiving selection does not initiate a route change')
  } finally { act(() => renderer!.unmount()) }
})

test('Web chip row forwards native attributes, children, events and ref without adding wrappers', () => {
  const node = { name: 'native div' }
  const ref = React.createRef<HTMLDivElement>()
  let clicks = 0
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebChipRow ref={ref} applied className="caller-layout" aria-label="筛选"
    data-navigation-group onClick={() => clicks++}><a href="#/browse">已选</a></WebChipRow>, { createNodeMock: () => node }) })
  try {
    const div = renderer!.root.findByType('div')
    assert.equal(renderer!.root.findAllByType('div').length, 1)
    assert.equal(div.props['data-web-filter-chips'], true)
    assert.equal(div.props['data-navigation-group'], true)
    assert.equal(div.props['aria-label'], '筛选')
    assert.match(div.props.className, /caller-layout/)
    assert.equal(ref.current, node)
    assert.equal(renderer!.root.findByType('a').props.href, '#/browse')
    act(() => { div.props.onClick() })
    assert.equal(clicks, 1)
  } finally { act(() => renderer!.unmount()) }
})

test('Web pagination retains endpoint disablement, count and controlled page changes', () => {
  const pages: number[] = []
  const onPageChange = (page: number): void => { pages.push(page) }
  let renderer: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<WebPagination page={1} total={54} pageSize={18} onPageChange={onPageChange} />) })
  try {
    assert.deepEqual(renderer!.root.findAllByType('button').map(button => button.props.disabled), [true, false])
    assert.equal(renderer!.root.findByType('span').children.join(''), '1 / 3')
    act(() => { renderer!.root.findAllByType('button')[1].props.onClick() })
    assert.deepEqual(pages, [2])
    act(() => { renderer!.update(<WebPagination page={3} total={54} pageSize={18} onPageChange={onPageChange} />) })
    assert.deepEqual(renderer!.root.findAllByType('button').map(button => button.props.disabled), [false, true])
    act(() => { renderer!.root.findAllByType('button')[0].props.onClick() })
    assert.deepEqual(pages, [2, 2])
    act(() => { renderer!.update(<WebPagination page={1} total={0} pageSize={18} onPageChange={onPageChange} />) })
    assert.equal(renderer!.root.findByType('span').children.join(''), '1 / 1')
    assert.deepEqual(renderer!.root.findAllByType('button').map(button => button.props.disabled), [true, true])
    assert.equal(renderer!.root.findByType('nav').props['aria-label'], '结果分页')
  } finally { act(() => renderer!.unmount()) }
})
