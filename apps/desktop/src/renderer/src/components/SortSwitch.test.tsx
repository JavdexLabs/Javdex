import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import SortSwitch from './SortSwitch'
import SelectControl from './SelectControl'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('keeps two shortcuts and exposes every field without changing the direction', () => {
  const options = [
    { value: 'release_date', label: '发行' }, { value: 'add_time', label: '添加' },
    { value: 'rating', label: '自定义评分' }, { value: 'external_rating', label: '外部评分' },
    { value: 'code', label: '番号' }
  ]
  let value = 'release_date'
  let dir: 'asc' | 'desc' = 'desc'
  let tree: TestRenderer.ReactTestRenderer
  const render = (): React.ReactElement => <SortSwitch label="排序" options={options}
    quickValues={['release_date', 'add_time']} value={value} dir={dir}
    onChange={(next, nextDir) => { value = next; dir = nextDir }} />
  act(() => { tree = TestRenderer.create(render()) })
  const menu = tree!.root.findByType(SelectControl)
  assert.equal(menu.props.children.length, 5)
  assert.equal(menu.props.displayLabel, '更多')
  act(() => { menu.props.onChange({ target: { value: 'external_rating' } }) })
  act(() => { tree.update(render()) })
  assert.equal(dir, 'desc')
  assert.equal(tree!.root.findByType(SelectControl).props.displayLabel, '更多')
  const buttons = tree!.root.findAllByType('button')
  assert.equal(buttons.length, 4)
  act(() => { buttons[3].props.onClick() })
  assert.equal(value, 'external_rating')
  assert.equal(dir, 'asc')
  act(() => { tree.unmount() })
})
