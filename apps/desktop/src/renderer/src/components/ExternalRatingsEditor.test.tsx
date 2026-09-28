import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ExternalRatingsEditor from './ExternalRatingsEditor'
import type { VideoEditInput } from '@shared/videoTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('selects a default and allows undoing a staged deletion without removing the row', () => {
  let value: NonNullable<VideoEditInput['externalRatings']> = { deletedSources: [], defaultSource: null }
  let tree: TestRenderer.ReactTestRenderer
  const render = (): React.ReactElement => <ExternalRatingsEditor
    ratings={[{ id: 1, video_id: 1, source: 'JavDB', rating_average: 4, rating_count: 100, fetched_at: null }]}
    value={value} disabled={false} onChange={(next) => { value = next }} />
  act(() => { tree = TestRenderer.create(render()) })
  const click = (label: string): void => {
    act(() => { tree.root.findAllByType('button').find((button) => button.props['aria-label'] === label)!.props.onClick() })
    act(() => { tree.update(render()) })
  }
  click('将 JavDB 设为默认外部评分')
  assert.equal(value.defaultSource, 'JavDB')
  click('删除 JavDB 评分')
  assert.deepEqual(value, { deletedSources: ['JavDB'], defaultSource: null })
  assert.equal(tree!.root.findAllByType('button').length, 2)
  click('撤销删除 JavDB 评分')
  assert.deepEqual(value.deletedSources, [])
  act(() => tree.unmount())
})
