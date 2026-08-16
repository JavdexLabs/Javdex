import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import OrganizationDeleteModal from './OrganizationDeleteModal'

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

function confirm(label: string): TestRenderer.ReactTestInstance {
  assert.ok(renderer)
  const button = renderer.root.findAllByType('button').find((item) => item.props.children === label)
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

describe('OrganizationDeleteModal', () => {
  it('previews and removes only the selected role', async () => {
    const calls: string[] = []
    await act(async () => {
      renderer = TestRenderer.create(
        <OrganizationDeleteModal
          mode="role"
          role="maker"
          organizationName="双角色机构"
          loadImpact={async () => ({
            id: 7,
            role: 'maker',
            roleVideoCount: 3,
            remainingRoles: ['publisher'],
            canRemove: true
          })}
          remove={async () => {
            calls.push('remove-maker')
            return {
              id: 7,
              role: 'maker',
              unlinkedVideoCount: 3,
              remainingRoles: ['publisher']
            }
          }}
          onCancel={() => {}}
          onCompleted={() => {
            calls.push('completed')
          }}
        />
      )
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /解除 3 部影片的制作商关联/)
    assert.match(text(), /其他机构角色、共享机构资料、所属系列和品牌图均会保留/)
    assert.equal(confirm('移除制作商角色').props.disabled, false)
    await act(async () => {
      confirm('移除制作商角色').props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.deepEqual(calls, ['remove-maker', 'completed'])
  })

  it('blocks removing the final role and directs the user to full deletion', async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        <OrganizationDeleteModal
          mode="role"
          role="publisher"
          organizationName="单角色机构"
          loadImpact={async () => ({
            id: 8,
            role: 'publisher',
            roleVideoCount: 1,
            remainingRoles: [],
            canRemove: false
          })}
          remove={async () => assert.fail('disabled final-role action must not run')}
          onCancel={() => {}}
          onCompleted={() => assert.fail('disabled final-role action must not complete')}
        />
      )
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /最后一个角色，不能单独移除/)
    assert.match(text(), /完整删除机构/)
    assert.equal(confirm('移除发行商角色').props.disabled, true)
  })

  it('shows both role counts and hierarchy impacts for a full deletion', async () => {
    let completed = false
    await act(async () => {
      renderer = TestRenderer.create(
        <OrganizationDeleteModal
          mode="organization"
          organizationName="完整删除机构"
          loadImpact={async () => ({
            id: 9,
            makerVideoCount: 2,
            publisherVideoCount: 4,
            directChildCount: 1,
            ownedSeriesCount: 3
          })}
          remove={async () => ({
            id: 9,
            unlinkedMakerVideoCount: 2,
            unlinkedPublisherVideoCount: 4,
            detachedChildCount: 1,
            detachedSeriesCount: 3,
            cleanupFailures: []
          })}
          onCancel={() => {}}
          onCompleted={() => {
            completed = true
          }}
        />
      )
      await Promise.resolve()
    })
    await settle()

    assert.match(text(), /2 部影片的制作商关联和 4 部影片的发行商关联/)
    assert.match(text(), /1 个直属子机构变为无上级、3 个所属系列变为未归属/)
    assert.match(text(), /影片、影片资源及其他影片元数据不会被删除/)
    await act(async () => {
      confirm('完整删除机构').props.onClick()
      await Promise.resolve()
      await Promise.resolve()
    })
    assert.equal(completed, true)
  })
})
