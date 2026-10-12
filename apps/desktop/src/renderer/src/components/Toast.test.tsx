import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { ToastProvider, useToast } from './Toast'
import { interactionLayers } from '../interaction/interactionLayers'
import { renderedText } from '../test/renderedText'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: { overflow: '' } }, activeElement: null } })
let renderer: TestRenderer.ReactTestRenderer | undefined
let copied = ''
const error = '服务端保存失败：' + '/很长的目录路径'.repeat(40)
function Actions() {
  const toast = useToast()
  return <><button onClick={() => toast.show(error, 'error')}>失败</button>
    <button onClick={() => toast.show('已保存', 'success')}>成功</button></>
}
const button = (label: string) => renderer!.root.findAllByType('button').find(node => renderedText(node) === label)!
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

test('errors persist and deduplicate while successes expire, full errors can be copied and dismissed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied = value } } } })
  act(() => { renderer = TestRenderer.create(<ToastProvider><Actions /></ToastProvider>) })
  act(() => { button('失败').props.onClick(); button('失败').props.onClick(); button('成功').props.onClick() })
  assert.equal(renderer!.root.findAllByType('button').filter(node => renderedText(node) === '查看详情').length, 1)
  act(() => context.mock.timers.tick(4000))
  assert.ok(!JSON.stringify(renderer!.toJSON()).includes('已保存'))
  assert.ok(JSON.stringify(renderer!.toJSON()).includes(error))
  act(() => button('查看详情').props.onClick())
  assert.equal(renderer!.root.findByType('p').children.join(''), error)
  await act(async () => { button('复制').props.onClick(); await Promise.resolve() })
  assert.equal(copied, error)
  const dialog = renderer!.root.findByProps({ role: 'dialog' })
  act(() => dialog.findAllByType('button').find(node => renderedText(node) === '关闭')!.props.onClick())
  act(() => button('关闭').props.onClick())
  assert.ok(!JSON.stringify(renderer!.toJSON()).includes(error))
})

test('a late clipboard completion cannot update a reopened error detail session', async () => {
  let finish!: () => void
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: {
    writeText: () => new Promise<void>(resolve => { finish = resolve })
  } } })
  act(() => { renderer = TestRenderer.create(<ToastProvider><Actions /></ToastProvider>) })
  act(() => button('失败').props.onClick())
  act(() => button('查看详情').props.onClick())
  act(() => button('复制').props.onClick())
  act(() => renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button')
    .find(node => renderedText(node) === '关闭')!.props.onClick())
  act(() => button('查看详情').props.onClick())
  await act(async () => { finish(); await Promise.resolve() })
  assert.ok(!JSON.stringify(renderer!.toJSON()).includes('已复制'))
})

test('only a visible nonempty toast stack marks visual occlusion without claiming modal ownership', () => {
  act(() => { renderer = TestRenderer.create(<ToastProvider><Actions /></ToastProvider>) })
  const stack = () => renderer!.root.findByProps({ 'aria-live': 'polite' })
  assert.equal(stack().props['data-native-playback-occluder'], undefined)
  assert.equal(stack().props['data-interaction-preserve-surface'], undefined)
  assert.equal(interactionLayers.hasModal(), false)
  act(() => button('失败').props.onClick())
  assert.equal(stack().props['data-native-playback-occluder'], true)
  assert.equal(stack().props['data-interaction-preserve-surface'], true)
  assert.equal(interactionLayers.hasModal(), false)
  act(() => button('查看详情').props.onClick())
  assert.equal(stack().props.hidden, true)
  assert.equal(stack().props['data-native-playback-occluder'], undefined)
  assert.equal(stack().props['data-interaction-preserve-surface'], undefined)
  act(() => renderer!.root.findByProps({ role: 'dialog' }).findAllByType('button')
    .find(node => renderedText(node) === '关闭')!.props.onClick())
  assert.equal(stack().props['data-native-playback-occluder'], true)
  act(() => button('关闭').props.onClick())
  assert.equal(stack().props['data-native-playback-occluder'], undefined)
  assert.equal(stack().props['data-interaction-preserve-surface'], undefined)
  assert.equal(interactionLayers.hasModal(), false)
})
