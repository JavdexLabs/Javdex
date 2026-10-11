import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import MetadataListInput, { type MetadataListOption } from './MetadataListInput'
import { appendMetadataList, metadataListValues, type MetadataListDraft } from './metadataListDraft'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: {} } })
let tree: TestRenderer.ReactTestRenderer | undefined
afterEach(() => { act(() => tree?.unmount()); tree = undefined })
const key = (name: string, isComposing = false) => ({ key: name, nativeEvent: { isComposing }, preventDefault() {}, stopPropagation() {} })

function show(initial: MetadataListDraft, search: (query: string) => Promise<MetadataListOption[]> = async () => []) {
  let draft = initial
  const render = () => <MetadataListInput id="cast" label="女优" value={draft} search={search}
    onChange={next => { draft = next; tree!.update(render()) }} />
  act(() => { tree = TestRenderer.create(render()) })
  return { draft: () => draft, input: () => tree!.root.findByType('input') }
}

it('splits pasted names and deduplicates without changing existing names', () => {
  const editor = show({ values: ['Alice'], input: '' })
  act(() => editor.input().props.onPaste({ clipboardData: { getData: () => 'alice，Beth\nCarol、Beth' },
    currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault() {} }))
  assert.deepEqual(editor.draft(), { values: ['Alice', 'Beth', 'Carol'], input: '' })
  assert.ok(tree!.root.findAll(node => node.props.role === 'status').some(node => node.children.includes('已忽略 2 个重复项')))
  const remove = tree!.root.findAllByType('button').find(node => node.props['aria-label'] === '移除女优 Beth')!
  act(() => remove.props.onClick())
  assert.deepEqual(editor.draft().values, ['Alice', 'Carol'])
})

it('selects canonical suggestions and keeps IME confirmation separate from adding', async () => {
  const calls: string[] = []
  const editor = show({ values: ['春乃真奈美'], input: '' }, async query => {
    calls.push(query)
    return [{ key: '1', name: '春乃真奈美' }, { key: '2', name: '春乃さくら' }]
  })
  act(() => editor.input().props.onChange({ target: { value: '春乃' } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  assert.deepEqual(calls, ['春乃'])
  assert.equal(tree!.root.findAll(node => node.props.role === 'option')[0].props['aria-selected'], true)
  act(() => editor.input().props.onKeyDown(key('Enter', true)))
  assert.equal(editor.draft().input, '春乃')
  const option = tree!.root.findByProps({ id: 'cast-option-1' })
  assert.ok(option)
  act(() => option.props.onClick())
  assert.deepEqual(editor.draft(), { values: ['春乃真奈美', '春乃さくら'], input: '' })
  act(() => editor.input().props.onChange({ target: { value: '新名称' } }))
  act(() => editor.input().props.onKeyDown(key('Enter')))
  assert.deepEqual(editor.draft().values, ['春乃真奈美', '春乃さくら', '新名称'])
})

it('ignores stale suggestions after query changes', async () => {
  const pending = new Map<string, (options: MetadataListOption[]) => void>()
  const editor = show({ values: [], input: '' }, query => new Promise(resolve => pending.set(query, resolve)))
  act(() => editor.input().props.onChange({ target: { value: 'old' } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  act(() => editor.input().props.onChange({ target: { value: 'new' } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  await act(async () => pending.get('new')!([{ key: 'new', name: 'New actor' }]))
  await act(async () => pending.get('old')!([{ key: 'old', name: 'Stale actor' }]))
  const text = JSON.stringify(tree!.toJSON())
  assert.ok(text.includes('New actor'))
  assert.ok(!text.includes('Stale actor'))
})

it('includes uncommitted input at save and preserves punctuation inside existing values', () => {
  assert.deepEqual(metadataListValues({ values: ['Actor, Jr.'], input: 'Alice\nBob，Alice' }), ['Actor, Jr.', 'Alice', 'Bob'])
  assert.deepEqual(appendMetadataList(['Café'], 'Cafe\u0301').values, ['Café'])
})

it('navigates up to the last suggestion and closes suggestions without consuming the draft', () => {
  const editor = show({ values: [], input: '' })
  act(() => editor.input().props.onChange({ target: { value: 'New actor' } }))
  act(() => editor.input().props.onKeyDown(key('ArrowUp')))
  assert.equal(editor.input().props['aria-activedescendant'], 'cast-option-0')
  let stopped = false
  act(() => editor.input().props.onKeyDown({ ...key('Escape'), stopPropagation() { stopped = true } }))
  assert.equal(stopped, true)
  assert.equal(editor.input().props['aria-expanded'], false)
  assert.deepEqual(editor.draft(), { values: [], input: 'New actor' })
  act(() => editor.input().props.onBlur({ relatedTarget: null }))
  assert.deepEqual(editor.draft(), { values: ['New actor'], input: '' })
})

it('bounds searches without truncating the value that will be saved', async () => {
  const calls: string[] = []
  const editor = show({ values: [], input: '' }, async query => { calls.push(query); return [] })
  const name = 'A'.repeat(501)
  act(() => editor.input().props.onChange({ target: { value: name } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  assert.equal(calls[0].length, 500)
  act(() => editor.input().props.onKeyDown(key('Enter')))
  assert.deepEqual(editor.draft().values, [name])
})

it('preserves separators inside a selected catalog name', async () => {
  const editor = show({ values: [], input: '' }, async () => [{ key: '1', name: 'Actor, Jr.' }])
  act(() => editor.input().props.onChange({ target: { value: 'Actor' } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  act(() => tree!.root.findByProps({ id: 'cast-option-0' }).props.onClick())
  assert.deepEqual(editor.draft(), { values: ['Actor, Jr.'], input: '' })
})
