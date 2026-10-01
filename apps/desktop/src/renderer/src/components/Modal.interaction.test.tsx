import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import Modal from './Modal'

const events = new EventTarget()
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: events })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body: { style: { overflow: '' } }, activeElement: null
} })
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })

test('busy dialogs block Escape, backdrop and cancel, then restore dismissal', () => {
  let cancelled = 0
  const tree = (busy: boolean) => <Modal title="编辑资料" busy={busy} onCancel={() => { cancelled++ }} onConfirm={() => {}}>表单</Modal>
  act(() => { renderer = TestRenderer.create(tree(true)) })
  assert.equal(renderer!.root.findByProps({ role: 'dialog' }).props['aria-busy'], true)
  assert.ok(renderer!.root.findAllByType('button').every(button => button.props.disabled))
  const escape = () => events.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
  const backdrop = () => {
    const node = renderer!.root.find(node => typeof node.props.onMouseDown === 'function')
    const target = {}
    node.props.onMouseDown({ target, currentTarget: target })
  }
  act(() => { escape(); backdrop() })
  assert.equal(cancelled, 0)
  act(() => { renderer!.update(tree(false)) })
  act(() => { escape(); backdrop() })
  assert.equal(cancelled, 2)
  assert.ok(renderer!.root.findAllByType('button').every(button => !button.props.disabled))
})

test('async confirmation locks duplicate clicks and retains errors for retry without losing the form', async () => {
  let calls = 0
  let reject!: (error: Error) => void
  const pending = new Promise<void>((_resolve, fail) => { reject = fail })
  const save = () => { calls++; return calls === 1 ? pending : Promise.resolve() }
  act(() => { renderer = TestRenderer.create(<Modal title="编辑" onCancel={() => {}} onConfirm={save}><input defaultValue="保留草稿" /></Modal>) })
  const confirm = () => renderer!.root.findAllByType('button').find(node => node.children.join('') === '确认')!
  act(() => { const click = confirm().props.onClick; click(); click() })
  assert.equal(calls, 1)
  assert.equal(renderer!.root.findByProps({ role: 'dialog' }).props['aria-busy'], true)
  await act(async () => { reject(new Error('服务端暂时不可用')); await Promise.resolve() })
  assert.equal(renderer!.root.findByType('input').props.defaultValue, '保留草稿')
  assert.equal(renderer!.root.findByType('p').children.join(''), '服务端暂时不可用')
  assert.ok(!confirm().props.disabled)
  await act(async () => { confirm().props.onClick(); await Promise.resolve() })
  assert.equal(calls, 2)
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
})

test('director editor forwards failed saves to the modal and retries its unchanged draft', async () => {
  const { default: DirectorEditModal } = await import('./DirectorEditModal')
  let calls = 0
  const save = async (input: { mainName: string }) => {
    assert.equal(input.mainName, '测试导演')
    if (++calls === 1) throw new Error('无法保存导演')
  }
  act(() => { renderer = TestRenderer.create(<DirectorEditModal onCancel={() => {}} onSave={save} />) })
  const input = () => renderer!.root.findByProps({ id: 'director-main-name' })
  act(() => input().props.onChange({ target: { value: '测试导演' } }))
  const saveButton = () => renderer!.root.findAllByType('button').find(node => node.children.join('') === '保存')!
  await act(async () => { saveButton().props.onClick(); await Promise.resolve() })
  assert.equal(input().props.value, '测试导演')
  assert.ok(renderer!.root.findAllByType('p').some(node => node.children.join('') === '无法保存导演'))
  await act(async () => { saveButton().props.onClick(); await Promise.resolve() })
  assert.equal(calls, 2)
  assert.equal(renderer!.root.findAllByProps({ role: 'alert' }).length, 0)
})
