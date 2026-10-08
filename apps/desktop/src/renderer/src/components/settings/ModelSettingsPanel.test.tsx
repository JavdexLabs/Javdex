import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer'
import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'
import ModelAdvancedPanel from './ModelAdvancedPanel'
import ModelProvidersPanel from './ModelProvidersPanel'
import ModelUsagePanel from './ModelUsagePanel'
import ProviderDetailModal from './ProviderDetailModal'
import SelectControl from '../SelectControl'
import ConfirmModal from '../ConfirmModal'
import { renderedText } from '../../test/renderedText'

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
    schemaVersion: 3,
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
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000 },

        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      },
      {
        workloadId: 'plugin-developer',
        model: { mode: 'inherit-default' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000 },

        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      },
      {
        workloadId: 'library-curator',
        model: { mode: 'inherit-default' },
        runtime: { thinkingLevel: 'medium', maxTokens: 0, timeoutMs: 120_000 },

        limits: { maxTurns: 0, maxContextTokens: 128_000 },
        resolution: { ready: true, modelRef: 'model:ready:first', providerName: 'Ready Provider', modelName: 'First Model' }
      }
    ]
  }
}

function customProviderSnapshot(): ModelManagementSnapshot {
  const current = snapshot()
  current.connections = current.connections.map((connection) =>
    connection.providerId === 'ready' ? { ...connection, source: 'custom' as const } : connection
  )
  current.assignments = []
  return current
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

    const save = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '保存')
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

  it('keeps connection primaries visible and nests model capabilities in provider details', () => {
    const commands: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={snapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })

    assert.match(text(), /能力与上限/)
    assert.match(text(), /API Key/)
    assert.match(text(), /服务地址（Base URL）/)
    assert.match(text(), /自动识别：probe/)
    assert.match(text(), /当前生效：probe/)
    const details = renderer!.root.findAllByType('details')
    assert.equal(Boolean(details[0].props.open), false)
    assert.equal(details.some((item) => item.props.open === true), true)

    const baseUrl = renderer!.root.findAllByType('input')[1]
    act(() => baseUrl.props.onChange({ target: { value: 'https://changed.invalid/v1' } }))
    const discover = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '查询远程模型')
    const tests = renderer!.root.findAllByType('button').filter((button) => renderedText(button) === '测试')
    assert.equal(discover?.props.disabled, true)
    assert.equal(tests.every((button) => button.props.disabled), true)
    assert.equal(commands.length, 0)
  })

  it('rejects a new provider ID collision while allowing an existing provider to be edited', async () => {
    const commands: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          snapshot={snapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })

    const newInputs = renderer!.root.findAllByType('input')
    act(() => {
      newInputs[0].props.onChange({ target: { value: 'New Provider' } })
      newInputs[1].props.onChange({ target: { value: 'https://new.invalid/v1' } })
      newInputs[3].props.onChange({ target: { value: 'ready' } })
    })
    const newSave = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '保存')!
    await act(async () => { await newSave.props.onClick() })
    assert.equal(commands.length, 0)
    assert.match(text(), /连接标识已存在/)

    renderer?.unmount()
    renderer = null
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={snapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })
    const existingInputs = renderer!.root.findAllByType('input')
    act(() => existingInputs[1].props.onChange({ target: { value: 'https://edited.invalid/v1' } }))
    const existingSave = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '保存')!
    await act(async () => { await existingSave.props.onClick() })
    assert.equal(commands.length, 1)
    assert.deepEqual(commands[0], {
      type: 'save-connection',
      connection: {
        providerId: 'ready',
        name: 'Ready Provider',
        source: 'builtin',
        protocol: 'openai-chat',
        baseUrl: 'https://edited.invalid/v1',
        local: false,
        agentCompatible: true,
        enabled: true,
        apiKeyAction: 'keep'
      }
    })
  })

  it('blocks deleting a model that is referenced by a workload', () => {
    const current = snapshot()
    current.models[1] = { ...current.models[1], builtin: false }
    current.assignments = current.assignments.map((assignment, index) => index === 0
      ? {
          ...assignment,
          model: { mode: 'explicit', modelRef: 'model:ready:second' },
          resolution: { ...assignment.resolution, modelRef: 'model:ready:second' }
        }
      : assignment)
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={current}
          busy={false}
          apply={async () => true}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })
    const deleteButtons = renderer!.root.findAllByType('button').filter((button) => renderedText(button) === '使用中')
    assert.equal(deleteButtons.length, 1)
    assert.equal(deleteButtons[0].props.disabled, true)
  })

  it('blocks model and provider deletion while an embedded capability draft is dirty', () => {
    const commands: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={customProviderSnapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })

    const overrideInputs = renderer!.root.findAllByType('input').filter((input) => input.props.type === 'number')
    assert.equal(overrideInputs.length, 4)
    act(() => overrideInputs[2].props.onChange({ target: { value: '65536' } }))

    const modelDelete = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '删除')
    const providerDelete = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '删除提供商…')
    assert.ok(modelDelete)
    assert.ok(providerDelete)
    assert.equal(modelDelete.props.disabled, true)
    assert.equal(providerDelete.props.disabled, true)

    act(() => modelDelete!.props.onClick())
    act(() => providerDelete!.props.onClick())
    assert.equal(renderer!.root.findAllByType(ConfirmModal).length, 0)
    assert.equal(commands.length, 0)
  })

  it('rechecks embedded capability drafts before destructive confirmation', () => {
    const commands: unknown[] = []
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={customProviderSnapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })

    const modelDelete = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '删除')!
    act(() => modelDelete.props.onClick())
    const modelConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === '删除模型')
    assert.ok(modelConfirm)

    const overrideInputs = renderer!.root.findAllByType('input').filter((input) => input.props.type === 'number')
    act(() => overrideInputs[2].props.onChange({ target: { value: '65536' } }))
    const updatedConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === '删除模型')
    assert.equal(updatedConfirm?.props.confirmDisabled, true)
    act(() => updatedConfirm?.props.onConfirm())
    assert.equal(commands.length, 0)

    renderer?.unmount()
    renderer = null
    act(() => {
      renderer = TestRenderer.create(
        <ProviderDetailModal
          providerId="ready"
          snapshot={customProviderSnapshot()}
          busy={false}
          apply={async (command) => { commands.push(command); return true }}
          onProviderSaved={() => {}}
          onClose={() => {}}
        />
      )
    })
    const providerDelete = renderer!.root.findAllByType('button').find((button) => renderedText(button) === '删除提供商…')!
    act(() => providerDelete.props.onClick())
    const providerConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === '删除提供商')
    assert.ok(providerConfirm)
    const providerOverrideInputs = renderer!.root.findAllByType('input').filter((input) => input.props.type === 'number')
    act(() => providerOverrideInputs[2].props.onChange({ target: { value: '65536' } }))
    const updatedProviderConfirm = renderer!.root.findAllByType(ConfirmModal).find((modal) => modal.props.title === '删除提供商')
    assert.equal(updatedProviderConfirm?.props.confirmDisabled, true)
    act(() => updatedProviderConfirm?.props.onConfirm())
    assert.equal(commands.length, 0)
  })

  it('keeps destructive confirmations locked until the provider or model request settles', async t => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { body: { style: {} }, activeElement: null } })
    t.after(() => {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    })
    for (const action of ['删除', '删除提供商…']) {
      let finish!: (ok: boolean) => void
      let requests = 0
      act(() => {
        renderer = TestRenderer.create(<ProviderDetailModal
          providerId="ready" snapshot={customProviderSnapshot()} busy={false}
          apply={() => { requests++; return new Promise<boolean>(resolve => { finish = resolve }) }}
          onProviderSaved={() => {}} onClose={() => {}} />)
      })
      const trigger = renderer!.root.findAllByType('button').find(button => renderedText(button) === action)!
      act(() => trigger.props.onClick())
      const confirmation = renderer!.root.findByType(ConfirmModal)
      const buttons = confirmation.findAllByType('button')
      const confirm = buttons.find(button => renderedText(button) === confirmation.props.confirmText)!
      const cancel = buttons.find(button => renderedText(button) === '取消')!
      act(() => { void confirm.props.onClick() })
      assert.equal(confirmation.findByProps({ role: 'dialog' }).props['aria-busy'], true)
      act(() => { void confirm.props.onClick(); cancel.props.onClick() })
      assert.equal(requests, 1)
      assert.equal(renderer!.root.findAllByType(ConfirmModal).length, 1)
      await act(async () => { finish(false) })
      assert.equal(confirmation.findByProps({ role: 'dialog' }).props['aria-busy'], undefined)
      act(() => cancel.props.onClick())
      assert.equal(renderer!.root.findAllByType(ConfirmModal).length, 0)
      act(() => renderer!.unmount())
      renderer = null
    }
  })
})
