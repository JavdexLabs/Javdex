import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import EmptyState from './EmptyState'
import IconButton from './IconButton'
import { AppFormSection } from './FormPrimitives'
import CodeEditor from './CodeEditor'
import Modal from './Modal'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
Object.defineProperty(globalThis, 'document', { configurable: true, value: {
  body: { style: { overflow: '' } }, activeElement: null
} })
let renderer: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined })
const legacy = /(?:^| )(?:empty-state(?:-[\w-]+)?|icon-btn(?:[-_][\w-]+)?|app-form-section(?:-[\w-]+)?|code-editor|modal(?:-[\w-]+)?|hint)(?: |$)/
function assertLocalClasses(): void {
  const nodes = renderer!.root.findAll(node => typeof node.type === 'string' && typeof node.props.className === 'string')
  for (const node of nodes) assert.doesNotMatch(node.props.className, legacy)
}

test('empty state retains its variant, copy, caller layout and live loading semantics', () => {
  act(() => { renderer = TestRenderer.create(<EmptyState variant="compact" title="暂无资料" description="说明"
    descriptionClassName="copy-layout" className="layout" icon={<span>图标</span>} />) })
  assert.equal(renderer!.root.findByProps({ 'data-empty-variant': 'compact' }).props.role, undefined)
  assert.match(renderer!.root.findByProps({ 'data-empty-part': 'description' }).props.className, /copy-layout/)
  assert.equal(renderer!.root.findByType('strong').children.join(''), '暂无资料')
  assertLocalClasses()
  act(() => { renderer!.update(<EmptyState loading title="加载中" />) })
  assert.equal(renderer!.root.findByProps({ role: 'status' }).props['aria-live'], 'polite')
})

test('icon button retains native label, tone, ref and disabled state without bridge classes', () => {
  const ref = React.createRef<HTMLButtonElement>()
  const element = { focus() {} }
  act(() => { renderer = TestRenderer.create(<IconButton ref={ref} label="删除" icon={<span>图标</span>}
    tone="danger" size="sm" disabled className="layout" />, { createNodeMock: () => element }) })
  const button = renderer!.root.findByType('button')
  assert.equal(ref.current, element)
  assert.equal(button.props['data-ui'], 'icon-button')
  assert.equal(button.props['aria-label'], '删除')
  assert.equal(button.props.title, '删除')
  assert.equal(button.props.disabled, true)
  assertLocalClasses()
})

test('form sections retain title, hint, actions and body with local presentation', () => {
  act(() => { renderer = TestRenderer.create(<AppFormSection title="字段分组" hint="说明"
    actions={<button>刷新</button>} className="layout"><input defaultValue="正文" /></AppFormSection>) })
  assert.equal(renderer!.root.findByType('h4').children.join(''), '字段分组')
  assert.equal(renderer!.root.findByType('p').children.join(''), '说明')
  assert.equal(renderer!.root.findByType('button').children.join(''), '刷新')
  assert.equal(renderer!.root.findByType('input').props.defaultValue, '正文')
  assertLocalClasses()
})

test('code editor retains native disabled editing, change and inaccessible highlight layer', () => {
  let value = ''
  act(() => { renderer = TestRenderer.create(<CodeEditor value="const a = 1;" disabled className="layout"
    aria-label="代码草稿" onChange={next => { value = next }} />) })
  const input = renderer!.root.findByType('textarea')
  assert.equal(input.props.value, 'const a = 1;')
  assert.equal(input.props.disabled, true)
  assert.equal(input.props['aria-label'], '代码草稿')
  assert.equal(renderer!.root.findByType('pre').props['aria-hidden'], 'true')
  input.props.onChange({ target: { value: '草稿' } })
  assert.equal(value, '草稿')
  assertLocalClasses()
})

test('modal retains labelled description, size, chrome and explicit body slots without legacy classes', () => {
  act(() => { renderer = TestRenderer.create(<Modal title="编辑" subtitle="对象" hint="说明" size="lg"
    onCancel={() => {}} onConfirm={() => {}}><p>正文</p></Modal>) })
  const dialog = renderer!.root.findByProps({ role: 'dialog' })
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.equal(renderer!.root.findByProps({ id: dialog.props['aria-labelledby'] }).children[0], '编辑')
  assert.equal(renderer!.root.findByProps({ id: dialog.props['aria-describedby'] }).children.join(''), '说明')
  assert.equal(renderer!.root.findByProps({ 'data-modal-part': 'body' }).findByType('p').children.join(''), '正文')
  assertLocalClasses()
  act(() => { renderer!.update(<Modal title="预览" chrome="shellless" hideActions onCancel={() => {}}>内容</Modal>) })
  assert.equal(renderer!.root.findByType('button').props['aria-label'], '关闭')
  assert.equal(renderer!.root.findAllByProps({ 'data-modal-part': 'actions' }).length, 0)
  assertLocalClasses()
})
