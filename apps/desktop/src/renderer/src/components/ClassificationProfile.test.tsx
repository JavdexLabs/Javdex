import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import ClassificationProfile from './ClassificationProfile'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

describe('ClassificationProfile', () => {
  it('keeps the no-image, no-meta, and empty-summary states inside the profile', () => {
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <ClassificationProfile
          kind="director"
          label="导演资料"
          kicker="导演"
          name="示例导演"
          imageUrl={null}
          placeholder={<svg aria-label="暂无肖像" />}
          aliases={[]}
          summary={null}
          links={[]}
        />
      )
    })

    assert.equal(renderer!.root.findByType('section').props['aria-label'], '导演资料')
    assert.equal(renderer!.root.findAllByType('img').length, 0)
    assert.equal(renderer!.root.findAllByType('svg').length, 1)
    assert.equal(renderer!.root.findByType('h1').children.join(''), '示例导演')
    assert.equal(renderer!.root.findByType('p').children.join(''), '暂无简介')
    assert.equal(renderer!.root.findAllByType('a').length, 0)
    act(() => { renderer!.unmount() })
  })
})
