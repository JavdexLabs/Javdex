import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('saves proxy address and mode only on explicit commit; testing stays independent', async () => {
  const updates: unknown[] = []
  const tested: unknown[] = []
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        settings: {
          update: async (patch: unknown) => {
            updates.push(patch)
            return patch
          },
          testProxy: async (...args: unknown[]) => {
            tested.push(args)
            return '连接正常'
          }
        }
      }
    }
  })
  const { ProxyConfigRow } = await import('./NetworkSettingsPanel')
  const { default: SelectControl } = await import('../SelectControl')
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    act(() => {
      renderer = TestRenderer.create(
        <ProxyConfigRow kind="scrape" savedValue="" enabled={false} onSaved={() => {}} />
      )
    })
    act(() =>
      renderer.root
        .findByType('input')
        .props.onChange({ target: { value: 'http://127.0.0.1:7890' } })
    )
    act(() =>
      renderer.root.findByType(SelectControl).props.onChange({ target: { value: 'proxy' } })
    )
    assert.deepEqual(updates, [])
    const test = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('测试连接'))!
    await act(async () => {
      test.props.onClick()
    })
    assert.deepEqual(tested, [['scrape', 'http://127.0.0.1:7890']])
    assert.deepEqual(updates, [])
    const save = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('保存'))!
    await act(async () => {
      save.props.onClick()
    })
    assert.deepEqual(updates, [{ proxyUrl: 'http://127.0.0.1:7890', proxyUrlEnabled: true }])
  } finally {
    act(() => renderer?.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
