import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import DirectorScrapeChoiceModal from './DirectorScrapeChoiceModal'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { addEventListener() {}, removeEventListener() {} }
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { activeElement: null, body: { style: { overflow: '' } } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

function renderedText(): string {
  type RenderNode = string | ReactTestRendererJSON | RenderNode[] | null
  const collect = (node: RenderNode): string => {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(collect).join('')
    return node.children?.map(collect).join('') ?? ''
  }
  return collect(renderer?.toJSON() ?? null)
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('DirectorScrapeChoiceModal', () => {
  it('requires an explicit candidate and submits its stable director id', () => {
    let chosenId: number | null = null
    act(() => {
      renderer = TestRenderer.create(
        <DirectorScrapeChoiceModal
          choice={{
            scrapedName: '同名导演',
            candidates: [
              {
                id: 18,
                mainName: '导演甲',
                aliases: ['同名导演'],
                description: 'JP · 出生 1960-01-01 · 4 部影片'
              },
              {
                id: 29,
                mainName: '导演乙',
                aliases: [],
                description: 'US · 出生 1980-01-01 · 2 部影片'
              }
            ]
          }}
          onCancel={() => {}}
          onChoose={(id) => {
            chosenId = id
          }}
        />
      )
    })

    assert.match(renderedText(), /同名导演.*导演甲.*别名：同名导演.*导演乙.*无别名/)
    assert.ok(renderer)
    const confirm = renderer.root
      .findAllByType('button')
      .find((button) => button.props.children === '应用所选导演')
    assert.ok(confirm)
    assert.equal(confirm.props.disabled, true)

    const candidates = renderer.root.findAll(
      (node) => node.type === 'button' && node.props.role === 'radio'
    )
    assert.equal(candidates.length, 2)
    act(() => candidates[1].props.onClick())
    assert.equal(confirm.props.disabled, false)
    act(() => confirm.props.onClick())
    assert.equal(chosenId, 29)
  })
})
