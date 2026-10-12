import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ExternalRatingsEditor from './ExternalRatingsEditor'
import { createExternalRatingsDraft, externalRatingsDraftErrors, externalRatingsFromDraft } from './externalRatingsDraft'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

const ratings = [
  { id: 1, video_id: 1, source: 'JavLibrary', rating_average: 3.5, rating_count: null, fetched_at: null, is_default: 1 },
  { id: 2, video_id: 1, source: 'JavDB', rating_average: 4.3, rating_count: 176, fetched_at: null }
]

function editor() {
  let value = createExternalRatingsDraft(ratings)
  let disabled = false
  let tree: TestRenderer.ReactTestRenderer
  const render = () => <ExternalRatingsEditor value={value} disabled={disabled} onChange={(next) => { value = next }} />
  act(() => { tree = TestRenderer.create(render()) })
  const refresh = () => act(() => { tree.update(render()) })
  const click = (label: string) => {
    act(() => { tree.root.findAllByType('button').find((button) => button.props['aria-label'] === label)!.props.onClick() })
    refresh()
  }
  const field = (label: string) => tree.root.findAllByType('input').find((input) => input.props['aria-label'] === label)!
  const change = (label: string, text: string) => {
    act(() => { field(label).props.onChange({ target: { value: text } }) })
    refresh()
  }
  return { click, change, field, value: () => value, tree: () => tree,
    disable: () => { disabled = true; refresh() }, unmount: () => act(() => tree.unmount()) }
}

it('keeps a renamed default tied to its row, stages deletion and retains edited values on undo', () => {
  const e = editor()
  const defaultKey = e.value().defaultKey
  e.change('来源 1', '')
  assert.equal(e.value().defaultKey, defaultKey)
  e.change('来源 1', ' Library ')
  e.change('评分 1', '')
  assert.equal(e.value().defaultKey, defaultKey)
  e.change('评分 1', '3.75')
  assert.equal(externalRatingsFromDraft(e.value()).defaultSource, 'Library')
  e.click('删除 Library 评分')
  assert.equal(e.field('来源 1').props.disabled, true)
  assert.equal(externalRatingsFromDraft(e.value()).defaultSource, 'JavDB')
  assert.deepEqual(externalRatingsFromDraft(e.value()).deletedSources, ['JavLibrary'])
  e.click('撤销删除 Library 评分')
  assert.equal(e.field('来源 1').props.value, ' Library ')
  assert.equal(e.field('评分 1').props.value, '3.75')
  assert.equal(externalRatingsFromDraft(e.value()).defaultSource, 'JavDB')
  act(() => e.field('将 Library 设为默认外部评分').props.onChange())
  assert.equal(externalRatingsFromDraft(e.value()).defaultSource, 'Library')
  e.unmount()
})

it('selects a usable fallback when a default score is intentionally cleared and blurred', () => {
  const e = editor()
  e.change('评分 1', '')
  act(() => e.field('评分 1').props.onBlur())
  assert.equal(externalRatingsFromDraft(e.value()).defaultSource, 'JavDB')
  e.unmount()
})

it('adds editable sources with optional counts, rejects duplicates and invalid numbers, and discards blank rows', () => {
  const e = editor()
  e.click('新增评分')
  assert.equal(externalRatingsDraftErrors(e.value()).size, 1)
  e.change('来源 3', 'JavDB')
  e.change('评分 3', '4.5')
  assert.equal(externalRatingsDraftErrors(e.value()).size, 2)
  e.change('来源 3', 'My source')
  e.change('评分人数 3', '1.5')
  assert.throws(() => externalRatingsFromDraft(e.value()), /人数/)
  e.change('评分人数 3', '')
  e.change('评分 3', '1e')
  assert.throws(() => externalRatingsFromDraft(e.value()), /有效数字/)
  e.change('评分 3', '4.5')
  assert.deepEqual(externalRatingsFromDraft(e.value()).entries, [
    { originalSource: null, source: 'My source', ratingAverage: 4.5, ratingCount: null }
  ])
  e.click('新增评分')
  e.click('移除 新增评分 4 评分')
  assert.equal(e.value().rows.length, 3)
  assert.equal(externalRatingsDraftErrors(e.value()).size, 0)
  e.disable()
  assert.ok(e.tree().root.findAllByType('input').every((input) => input.props.disabled))
  assert.ok(e.tree().root.findAllByType('button').every((button) => button.props.disabled))
  e.unmount()
})

it('preserves score precision and null metadata on untouched rows', () => {
  const value = createExternalRatingsDraft([{ ...ratings[0], rating_average: 4.275, rating_count: null }])
  assert.equal(value.rows[0].score, '4.275')
  assert.deepEqual(externalRatingsFromDraft(value), { deletedSources: [], defaultSource: 'JavLibrary', entries: [] })
})
