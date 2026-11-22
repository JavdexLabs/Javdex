import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { DEFAULT_SETTINGS, type SettingsSnapshot } from '@shared/settingsTypes'
import { renderedText } from '../../test/renderedText'

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
  const { default: NetworkSettingsPanel } = await import('./NetworkSettingsPanel')
  const { default: SelectControl } = await import('../SelectControl')
  const settings: SettingsSnapshot = {
    ...DEFAULT_SETTINGS,
    mediaAssetsResolvedPath: '',
    recoveryNotice: null,
    llmSecretStorage: { protection: 'unavailable', backend: 'test' }
  }
  let renderer!: TestRenderer.ReactTestRenderer
  try {
    act(() => {
      renderer = TestRenderer.create(
        <NetworkSettingsPanel settings={settings} onSaved={() => {}} />
      )
    })
    const selectedMode = renderer.root.findAllByType('button').find((button) => button.props['aria-pressed'])
    assert.equal(selectedMode && visibleText(selectedMode), '跟随系统')
    const features = renderer.root.findByType('section')
    assert.equal(features.findAllByType('details').length, 0)
    assert.equal(features.findAllByType(SelectControl).length, 4)
    assert.equal(renderer.root.findAllByType('input').length, 0)
    const manualMode = renderer.root.findAllByType('button').find((button) => visibleText(button) === '手动代理')!
    act(() => manualMode.props.onClick())
    act(() =>
      renderer.root
        .findByType('input')
        .props.onChange({ target: { value: 'http://127.0.0.1:7890' } })
    )
    const downloadsSelect = renderer.root.findAllByType(SelectControl).at(-1)!
    assert.equal(downloadsSelect.props.value, 'inherit')
    act(() => downloadsSelect.props.onChange({ target: { value: 'manual' } }))
    const downloadAddress = features.findByType('input')
    assert.equal(downloadAddress.props['aria-label'], '模型与运行库下载代理地址')
    act(() => downloadAddress.props.onChange({ target: { value: 'invalid' } }))
    const save = renderer.root.findAllByType('button').find((button) => renderedText(button) === '保存')!
    await act(async () => { save.props.onClick() })
    assert.equal(downloadAddress.props['aria-invalid'], true)
    const localFeedback = features.findByProps({ id: downloadAddress.props['aria-describedby'] })
    assert.match(visibleText(localFeedback), /有效的 HTTP/)
    act(() => downloadsSelect.props.onChange({ target: { value: 'direct' } }))
    assert.equal(features.findAllByType('input').length, 0)
    assert.deepEqual(updates, [])
    const test = renderer.root
      .findAllByType('button')
      .find((button) => visibleText(button) === '测试连接')!
    await act(async () => {
      test.props.onClick()
    })
    assert.deepEqual(tested, [['updates', { mode: 'manual', url: 'http://127.0.0.1:7890' }]])
    assert.deepEqual(updates, [])
    await act(async () => {
      save.props.onClick()
    })
    assert.deepEqual(updates, [{ networkProxy: {
      default: { mode: 'manual', url: 'http://127.0.0.1:7890' },
      overrides: { downloads: { mode: 'direct' } }
    } }])
  } finally {
    act(() => renderer?.unmount())
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})

function visibleText(node: TestRenderer.ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => visibleText(child as TestRenderer.ReactTestInstance)).join('')
}
