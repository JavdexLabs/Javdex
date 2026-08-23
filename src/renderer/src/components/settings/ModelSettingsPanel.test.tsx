import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import ModelAdvancedPanel from './ModelAdvancedPanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import ModelUsagePanel from './ModelUsagePanel'
import SelectControl from '../SelectControl'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function metadata(tools: boolean) {
  return {
    api: 'openai-completions' as const,
    contextWindow: 128_000,
    maxTokens: 16_384,
    capabilities: { tools, vision: 'unknown' as const, reasoning: true },
    cache: {
      supportsPromptCache: true,
      supportsLongCacheRetention: false,
      sendSessionAffinityHeaders: false,
      evidence: { source: 'probe' as const, checkedAt: '2026-08-22T00:00:00.000Z' }
    }
  }
}

function snapshot(): ModelManagementSnapshot {
  const first = metadata(true)
  const second = metadata(true)
  return {
    schemaVersion: 2,
    revision: 'revision-1',
    updatedAt: '2026-08-22T00:00:00.000Z',
    validationErrors: [],
    connections: [
      {
        id: 'connection:available',
        providerId: 'available',
        name: 'Available Provider',
        source: 'builtin',
        protocol: 'openai-chat',
        baseUrl: 'https://available.invalid/v1',
        local: false,
        agentCompatible: true,
        enabled: true,
        hasCredential: false,
        status: 'unconfigured',
        modelCount: 0
      },
      {
        id: 'connection:ready',
        providerId: 'ready',
        name: 'Ready Provider',
        source: 'builtin',
        protocol: 'openai-chat',
        baseUrl: 'https://ready.invalid/v1',
        local: false,
        agentCompatible: true,
        enabled: true,
        hasCredential: true,
        status: 'ready',
        modelCount: 2
      }
    ],
    models: [
      {
        id: 'model:ready:first',
        connectionId: 'connection:ready',
        modelId: 'first',
        name: 'First Model',
        kind: 'chat',
        builtin: true,
        baseline: first,
        effective: first,
        hasManualOverrides: false
      },
      {
        id: 'model:ready:second',
        connectionId: 'connection:ready',
        modelId: 'second',
        name: 'Second Model',
        kind: 'chat',
        builtin: false,
        baseline: second,
        effective: second,
        hasManualOverrides: false
      }
    ],
    assignments: [
      {
        workloadId: 'app-default',
        model: { mode: 'explicit', modelRef: 'model:ready:first' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000, cacheRetention: 'short' },
        compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 32_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      },
      {
        workloadId: 'plugin-developer',
        model: { mode: 'inherit-default' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000, cacheRetention: 'short' },
        compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 32_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      },
      {
        workloadId: 'library-curator',
        model: { mode: 'inherit-default' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000, cacheRetention: 'short' },
        compaction: { enabled: true, reserveTokens: 16_000, keepRecentTokens: 32_000 },
        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      }
    ]
  }
}

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

describe('Model management v2 panels', () => {
  it('keeps workload edits local until the explicit save action', () => {
    const commands: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <ModelUsagePanel
          snapshot={snapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
        />
      )
    })

    const selects = renderer!.root.findAllByType(SelectControl)
    act(() => selects[0].props.onChange({ target: { value: 'model:ready:second' } }))
    assert.equal(commands.length, 0)

    const save = renderer!.root.findAllByType('button').find((button) => button.children.includes('保存'))
    assert.ok(save)
    act(() => save.props.onClick())
    assert.deepEqual(commands, [{ type: 'set-default-model', modelRef: 'model:ready:second' }])
    assert.doesNotMatch(text(), /Route|Preset|Profile|ToolPack|verifier|grants/)
  })

  it('shows configured providers first and keeps unconfigured built-ins collapsed', () => {
    act(() => {
      renderer = TestRenderer.create(
        <ModelProvidersPanel snapshot={snapshot()} busy={false} apply={async () => true} />
      )
    })
    assert.match(text(), /Ready Provider/)
    assert.doesNotMatch(text(), /Available Provider/)

    const disclosure = renderer!.root.findByProps({ 'aria-expanded': false })
    act(() => disclosure.props.onClick())
    assert.ok(text().indexOf('Ready Provider') < text().indexOf('Available Provider'))
  })

  it('limits the default advanced view to models referenced by workloads', () => {
    act(() => {
      renderer = TestRenderer.create(
        <ModelAdvancedPanel snapshot={snapshot()} busy={false} apply={async () => true} />
      )
    })
    assert.match(text(), /First Model/)
    assert.doesNotMatch(text(), /Second Model/)
  })
})
