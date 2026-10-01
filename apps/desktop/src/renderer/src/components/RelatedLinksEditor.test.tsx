import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React, { useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import RelatedLinksEditor from './RelatedLinksEditor'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function Harness({ disabled = false, removeVerb = '删除' }: {
  disabled?: boolean
  removeVerb?: '删除' | '移除'
}): JSX.Element {
  const [links, setLinks] = useState([
    { label: '官网', url: 'https://example.com' },
    { label: '补充', url: 'https://example.com/extra' }
  ])
  return <RelatedLinksEditor links={links} disabled={disabled} removeVerb={removeVerb} onChange={setLinks} />
}

function button(label: string): TestRenderer.ReactTestInstance {
  const found = renderer!.root.findAllByType('button').find((item) => item.props['aria-label'] === label)
  assert.ok(found, `missing button: ${label}`)
  return found
}

function labels(): string[] {
  return renderer!.root.findAllByType('input')
    .filter((item) => String(item.props['aria-label']).endsWith('名称'))
    .map((item) => item.props.value)
}

describe('RelatedLinksEditor', () => {
  it('edits, reorders, adds, and removes links while keeping accessible actions', () => {
    act(() => { renderer = TestRenderer.create(<Harness removeVerb="移除" />) })
    assert.deepEqual(labels(), ['官网', '补充'])
    assert.equal(button('上移链接 1').props.disabled, true)

    act(() => { button('上移链接 2').props.onClick() })
    assert.deepEqual(labels(), ['补充', '官网'])

    act(() => { renderer!.root.findAllByType('input')[0].props.onChange({ target: { value: '更新名称' } }) })
    assert.deepEqual(labels(), ['更新名称', '官网'])

    act(() => { renderer!.root.findAllByType('button').find((item) => item.children.includes('添加链接'))!.props.onClick() })
    assert.deepEqual(labels(), ['更新名称', '官网', ''])
    act(() => { button('移除链接 3').props.onClick() })
    assert.deepEqual(labels(), ['更新名称', '官网'])
  })

  it('disables every editing action when the form is busy', () => {
    act(() => { renderer = TestRenderer.create(<Harness disabled />) })
    assert.ok(renderer!.root.findAllByType('input').every((item) => item.props.disabled))
    assert.ok(renderer!.root.findAllByType('button').every((item) => item.props.disabled))
  })
})
