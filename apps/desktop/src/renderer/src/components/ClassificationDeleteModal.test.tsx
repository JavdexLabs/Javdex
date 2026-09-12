import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import ClassificationDeleteModal from './ClassificationDeleteModal'

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

function text(): string {
  type RenderNode = string | ReactTestRendererJSON | RenderNode[] | null
  const collect = (node: RenderNode): string => {
    if (node == null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(collect).join('')
    return node.children?.map(collect).join('') ?? ''
  }
  return collect(renderer?.toJSON() ?? null)
}

function confirm(): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const button = renderer.root.findAllByType('button').find((item) => item.props.children === '删除系列')
  assert.ok(button)
  return button
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

describe('ClassificationDeleteModal', () => {
  it('shows associated video and child impacts before confirming deletion', async () => {
    let removed = false
    await act(async () => {
      renderer = TestRenderer.create(
        <ClassificationDeleteModal
          entityLabel="系列"
          entityName="演示系列"
          loadImpact={async () => ({ id: 8, videoCount: 3, directChildCount: 2 })}
          remove={async () => {
            removed = true
            return {
              id: 8,
              unlinkedVideoCount: 4,
              detachedChildCount: 2,
              cleanupFailures: []
            }
          }}
          onCancel={() => {}}
          onDeleted={() => {}}
        />
      )
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /解除 3 部影片/)
    assert.match(text(), /2 个直接子系列变为无上级/)
    assert.match(text(), /影片、影片资源及其他影片元数据不会被删除/)
    assert.equal(confirm().props.disabled, false)
    await act(async () => {
      confirm().props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(removed, true)
  })

  it('allows a zero-impact deletion and keeps a failed confirmation open with refreshed impact', async () => {
    let previews = 0
    await act(async () => {
      renderer = TestRenderer.create(
        <ClassificationDeleteModal
          entityLabel="系列"
          entityName="空系列"
          loadImpact={async () => {
            previews += 1
            return { id: 9, videoCount: 0, directChildCount: 0 }
          }}
          remove={async () => {
            throw new Error('删除事务失败，请重试')
          }}
          onCancel={() => {}}
          onDeleted={() => assert.fail('failed deletion must not close the modal')}
        />
      )
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /解除 0 部影片/)
    assert.equal(confirm().props.disabled, false)
    await act(async () => {
      confirm().props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /删除事务失败，请重试/)
    assert.match(text(), /删除系列/)
    assert.equal(previews, 2)
    assert.equal(confirm().props.disabled, false)
  })

  it('does not report or re-preview a completed deletion when page cleanup fails', async () => {
    let previews = 0
    const originalError = console.error
    const logged: unknown[][] = []
    console.error = (...args: unknown[]) => logged.push(args)
    try {
      await act(async () => {
        renderer = TestRenderer.create(
          <ClassificationDeleteModal
            entityLabel="系列"
            entityName="已删除系列"
            loadImpact={async () => {
              previews += 1
              return { id: 10, videoCount: 1, directChildCount: 0 }
            }}
            remove={async () => ({
              id: 10,
              unlinkedVideoCount: 1,
              detachedChildCount: 0,
              cleanupFailures: []
            })}
            onCancel={() => {}}
            onDeleted={async () => {
              throw new Error('cache refresh failed')
            }}
          />
        )
        await Promise.resolve()
      })
      await settle()
      await act(async () => {
        confirm().props.onClick()
        await Promise.resolve()
        await Promise.resolve()
      })

      assert.equal(previews, 1)
      assert.doesNotMatch(text(), /cache refresh failed|删除事务失败/)
      assert.equal(logged.length, 1)
    } finally {
      console.error = originalError
    }
  })
})
