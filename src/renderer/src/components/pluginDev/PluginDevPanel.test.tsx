import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter } from 'react-router-dom'
import type { ElectronApi } from '../../../../preload/index'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let resolution = { ready: true, modelName: 'DeepSeek V4 Flash', reason: undefined as string | undefined }
const fakeApi = {
  settings: {
    getModelManagement: async () => ({
      connections: [], models: [], validationErrors: [],
      assignments: [{ workloadId: 'plugin-developer', resolution }]
    } as unknown as ModelManagementSnapshot)
  },
  pluginDev: {
    snapshot: async () => null,
    onAgentEvent: () => () => {},
    discardUnrecoverableSessions: async () => {}
  },
  scrape: { listPluginDetails: async () => [] },
  actressScrape: { listPluginDetails: async () => [] }
} as unknown as ElectronApi
Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: fakeApi } })

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('')
}

it('guides a configured model user to the missing website, then enables development', async () => {
  const { default: PluginDevPanel } = await import('./PluginDevPanel')
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<MemoryRouter><PluginDevPanel
      loadPackage={null} onInstalled={async () => {}} onLoadConsumed={() => {}}
    /></MemoryRouter>)
  })
  try {
    assert.ok(text(renderer.root).includes('DeepSeek V4 Flash'))
    const attention = renderer.root.findByProps({ className: 'plugin-dev-config-attention' })
    assert.equal(text(attention), '下一步请先填写网站主页。')
    await act(async () => {
      renderer.root.findByProps({ placeholder: 'https://example.com' }).props.onChange({ target: { value: 'https://example.test' } })
    })
    assert.equal(renderer.root.findAllByProps({ className: 'plugin-dev-config-attention' }).length, 0)
    const develop = renderer.root.findAllByType('button').find((button) => text(button) === 'AI开发')
    assert.ok(develop)
    assert.equal(develop.props.disabled, false)
  } finally {
    await act(async () => renderer.unmount())
  }
})

it('keeps the actual model readiness reason when a named model cannot run', async () => {
  resolution = { ready: false, modelName: 'DeepSeek V4 Flash', reason: '当前模型不支持工具调用。' }
  const { default: PluginDevPanel } = await import('./PluginDevPanel')
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(<MemoryRouter><PluginDevPanel
      loadPackage={null} onInstalled={async () => {}} onLoadConsumed={() => {}}
    /></MemoryRouter>)
  })
  try {
    assert.equal(text(renderer.root.findByProps({ className: 'plugin-dev-config-attention' })), '模型未就绪当前模型不支持工具调用。')
  } finally {
    await act(async () => renderer.unmount())
  }
})
