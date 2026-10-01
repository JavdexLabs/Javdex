import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import TextInput from './TextInput'
import TextArea from './TextArea'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | null = null
afterEach(() => { renderer?.unmount(); renderer = null })

test('text input forwards native search properties, ref and editing callbacks', () => {
  const ref = React.createRef<HTMLInputElement>()
  const node = { focus: () => {} }
  let value = ''
  act(() => {
    renderer = TestRenderer.create(<TextInput ref={ref} density="workspace" type="search"
      id="search" aria-label="筛选" autoFocus disabled maxLength={24} defaultValue="草稿"
      className="caller" onChange={event => { value = event.target.value }} />,
    { createNodeMock: element => element.type === 'input' ? node : null })
  })
  const input = renderer!.root.findByType('input')
  assert.equal(ref.current, node)
  assert.equal(input.props.type, 'search')
  assert.equal(input.props['aria-label'], '筛选')
  assert.equal(input.props.autoFocus, true)
  assert.equal(input.props.disabled, true)
  assert.equal(input.props.maxLength, 24)
  assert.equal(input.props.defaultValue, '草稿')
  assert.equal(input.props['data-density'], 'workspace')
  assert.match(input.props.className, /(?:^| )caller(?: |$)/)
  input.props.onChange({ target: { value: '更新' } })
  assert.equal(value, '更新')
})

test('existing default and filter input densities stay opt-in', () => {
  act(() => { renderer = TestRenderer.create(<TextInput variant="filter" type="password" readOnly value="secret" />) })
  const input = renderer!.root.findByType('input')
  assert.equal(input.props['data-density'], 'default')
  assert.equal(input.props['data-variant'], 'filter')
  assert.equal(input.props.type, 'password')
  assert.equal(input.props.readOnly, true)
  assert.equal(input.props.value, 'secret')
})

test('textarea preserves native multiline properties, ref and controlled editing', () => {
  const ref = React.createRef<HTMLTextAreaElement>()
  const node = { focus: () => {} }
  let value = ''
  let key = ''
  act(() => {
    renderer = TestRenderer.create(<TextArea ref={ref} density="workspace" rows={5} cols={40}
      value={'第一行\n第二行'} aria-describedby="hint" required readOnly className="caller"
      onChange={event => { value = event.target.value }} onKeyDown={event => { key = event.key }} />,
    { createNodeMock: element => element.type === 'textarea' ? node : null })
  })
  const textarea = renderer!.root.findByType('textarea')
  assert.equal(ref.current, node)
  assert.equal(textarea.props.rows, 5)
  assert.equal(textarea.props.cols, 40)
  assert.equal(textarea.props.value, '第一行\n第二行')
  assert.equal(textarea.props['aria-describedby'], 'hint')
  assert.equal(textarea.props.required, true)
  assert.equal(textarea.props.readOnly, true)
  assert.equal(textarea.props['data-density'], 'workspace')
  assert.match(textarea.props.className, /(?:^| )caller(?: |$)/)
  textarea.props.onChange({ target: { value: '保留草稿' } })
  textarea.props.onKeyDown({ key: 'Enter' })
  assert.equal(value, '保留草稿')
  assert.equal(key, 'Enter')
})
