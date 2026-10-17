import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SettingsFormActions from './SettingsFormActions'
import { renderedText } from '../../test/renderedText'

Object.assign(globalThis, { React })

test('save failure preserves its controls and only reveals inline details on request', async () => {
  let saves = 0
  let cancellations = 0
  const props = { dirty: true, onSave: () => { saves++ }, onCancel: () => { cancellations++ } }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<SettingsFormActions {...props} error="HTTP 503 · Service Unavailable" />) })
  const button = (name: string): TestRenderer.ReactTestInstance => renderer.root.findAllByType('button')
    .find(item => item.props['aria-label'] === name || renderedText(item) === name)!
  assert.equal(renderer.root.findAllByProps({ 'aria-label': '保存错误详情' }).length, 0)
  act(() => button('保存失败').props.onClick())
  assert.equal(button('保存失败').props['aria-expanded'], true)
  assert.match(renderedText(renderer.root.findByProps({ 'aria-label': '保存错误详情' })), /当前修改已保留/)
  assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.match(renderedText(renderer.root.findByType('pre')), /HTTP 503/)
  act(() => button('重试').props.onClick())
  assert.equal(saves, 1)
  act(() => button('取消更改').props.onClick())
  assert.equal(cancellations, 1)
  // Clearing an error closes its details. The same later error must not auto-expand.
  act(() => renderer.update(<SettingsFormActions {...props} saving />))
  assert.equal(button('保存中').props['aria-busy'], true)
  act(() => renderer.update(<SettingsFormActions {...props} error="HTTP 503 · Service Unavailable" />))
  assert.equal(button('保存失败').props['aria-expanded'], false)
  act(() => renderer.unmount())
})

test('conflict action opens explanation instead of saving over an external update', () => {
  let saves = 0
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<SettingsFormActions dirty={false} conflict saveDisabled onSave={() => { saves++ }} onCancel={() => {}} />) })
  const view = renderer.root.findAllByType('button').find(item => item.props['aria-label'] === '查看')!
  assert.equal(view.props.disabled, false)
  act(() => view.props.onClick())
  assert.equal(saves, 0)
  assert.match(renderedText(renderer.root.findByProps({ 'aria-label': '配置冲突详情' })), /读取最新配置/)
  assert.equal(renderer.root.findAllByType('button').find(item => item.props['aria-label'] === '取消更改')!.props.disabled, false)
  act(() => renderer.unmount())
})

test('technical details copy reports both success and failure without opening a dialog', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  let copied = ''
  let fail = false
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (text: string) => {
    if (fail) throw new Error('clipboard unavailable')
    copied = text
  } } } })
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    act(() => { renderer = TestRenderer.create(<SettingsFormActions dirty error="EROFS: read-only file system" onSave={() => {}} onCancel={() => {}} />) })
    act(() => renderer.root.findAllByType('button').find(item => renderedText(item) === '保存失败')!.props.onClick())
    const copy = (): TestRenderer.ReactTestInstance => renderer.root.findByProps({ 'aria-label': '复制技术详情' })
    await act(async () => { await copy().props.onClick() })
    assert.equal(copied, 'EROFS: read-only file system')
    assert.match(renderedText(copy()), /已复制/)
    fail = true
    await act(async () => { await copy().props.onClick() })
    assert.match(renderedText(copy()), /复制失败/)
    assert.equal(renderer.root.findAllByProps({ role: 'dialog' }).length, 0)
  } finally {
    act(() => renderer.unmount())
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('segmented toolbar exposes saved, dirty and saving states on one control', () => {
  let renderer!: TestRenderer.ReactTestRenderer
  const props = { onSave: () => {}, onCancel: () => {} }
  act(() => { renderer = TestRenderer.create(<SettingsFormActions dirty={false} {...props} />) })
  const toolbar = (): TestRenderer.ReactTestInstance => renderer.root.findByProps({ role: 'group', 'aria-label': '保存设置' })
  const button = (name: string): TestRenderer.ReactTestInstance => renderer.root.findAllByType('button').find(item => item.props['aria-label'] === name)!
  assert.equal(toolbar().props['data-state'], 'saved')
  assert.equal(button('保存').props.disabled, true)
  assert.equal(button('取消更改').props.disabled, true)
  act(() => renderer.update(<SettingsFormActions dirty {...props} />))
  assert.equal(toolbar().props['data-state'], 'dirty')
  assert.equal(button('保存').props['data-state'], 'dirty')
  assert.equal(button('保存').props.disabled, false)
  assert.equal(button('取消更改').props.disabled, false)
  act(() => renderer.update(<SettingsFormActions dirty saving {...props} />))
  assert.equal(toolbar().props['data-state'], 'saving')
  assert.equal(button('保存中').props.disabled, true)
  assert.equal(button('取消更改').props.disabled, true)
  act(() => renderer.unmount())
})
