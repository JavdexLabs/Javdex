import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import type { ExportModalState } from './NfoExportPanel'
import type { NfoExportPlanPreview, NfoExportStateEvent } from '@shared/nfoExportTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
const mockApi: Record<string, unknown> = {}
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: mockApi }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function running(): ExportModalState {
  return {
    taskId: 'task',
    terminating: false,
    report: null,
    progress: {
      taskId: 'task',
      completed: 1,
      total: 3,
      current: { id: 'file', kind: 'nfo', displayName: 'ABP-123 / ABP-123.nfo', videoCode: 'ABP-123' }
    }
  }
}

function returnedPlan(): NfoExportPlanPreview {
  return {
    planId: '00000000-0000-4000-8000-000000000001',
    request: {
      libraryIds: [1], profileId: 'portable-v1', includeCover: true,
      includeFanart: true, includeSamples: false, includeActorAvatars: false,
      collisionPolicy: 'skip'
    },
    summary: {
      videoCount: 1, resourceCount: 1, fileCount: 2, createCount: 2,
      replaceCount: 0, skipCount: 0, conflictCount: 0, unavailableCount: 0,
      skippedNoAnchorCount: 0, warningCount: 0, sampleCount: 0, estimatedBytes: 128
    },
    files: [{
      id: 'file', kind: 'nfo', displayName: 'ABC-001 / ABC-001.nfo',
      videoCode: 'ABC-001', action: 'create', bytes: 128
    }],
    warnings: []
  }
}

function instanceText(node: ReactTestInstance): string {
  return node.children.map((child) =>
    typeof child === 'string' ? child : instanceText(child)
  ).join('')
}

describe('NFO export foreground modal', () => {
  it('vetoes full-page unload while the foreground modal is active', async () => {
    const { preventNfoExportUnload } = await import('./NfoExportPanel')
    let prevented = 0
    const event = {
      preventDefault: () => { prevented += 1 },
      returnValue: undefined
    }
    preventNfoExportUnload(event as unknown as BeforeUnloadEvent)
    assert.equal(prevented, 1)
    assert.equal(event.returnValue, '')
  })

  it('is an aria-modal task surface with an explicit terminate action and no dismiss action', async () => {
    const { ExportProgressModal } = await import('./NfoExportPanel')
    let terminations = 0
    await act(async () => {
      renderer = TestRenderer.create(
        <ExportProgressModal
          modal={running()}
          onTerminate={async () => { terminations += 1 }}
          onClose={() => assert.fail('running task must not close')}
        />
      )
    })
    const dialog = renderer!.root.findByProps({ role: 'dialog' })
    assert.equal(dialog.props['aria-modal'], 'true')
    const buttons = renderer!.root.findAllByType('button')
    assert.equal(buttons.length, 1)
    assert.match(String(buttons[0].props.children), /终止/u)
    await act(async () => { await buttons[0].props.onClick() })
    assert.equal(terminations, 1)
  })

  it('keeps the terminal report open until the user confirms it', async () => {
    const { ExportProgressModal } = await import('./NfoExportPanel')
    let closes = 0
    const modal: ExportModalState = {
      ...running(),
      report: {
        taskId: 'task', startedAt: '', finishedAt: '', terminated: true,
        writtenCount: 1, skippedCount: 2, failedCount: 0, items: []
      }
    }
    act(() => {
      renderer = TestRenderer.create(
        <ExportProgressModal modal={modal} onTerminate={async () => undefined} onClose={() => { closes += 1 }} />
      )
    })
    const buttons = renderer!.root.findAllByType('button')
    assert.equal(buttons.length, 1)
    act(() => { buttons[0].props.onClick() })
    assert.equal(closes, 1)
  })

  it('renders a returned plan and enters blocking state before foreground execution', async () => {
    const { default: NfoExportPanel } = await import('./NfoExportPanel')
    let stateListener: ((event: NfoExportStateEvent) => void) | null = null
    let planned = 0
    let blocking = false
    mockApi.nfoExport = {
      getOptions: async () => ({
        libraries: [{ id: 1, name: 'Main' }],
        profiles: [{
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable',
          supportsSampleReferences: true
        }],
        preferences: {
          libraryIds: [1], profileId: 'portable-v1', includeCover: true,
          includeFanart: true, includeSamples: false, includeActorAvatars: false
        }
      }),
      updatePreferences: async (value: unknown) => value,
      plan: async () => {
        planned += 1
        return returnedPlan()
      },
      discardPlan: async () => undefined,
      start: async () => ({ taskId: 'task' }),
      terminate: async () => undefined,
      onProgress: () => () => undefined,
      onState: (listener: (event: NfoExportStateEvent) => void) => {
        stateListener = listener
        return () => undefined
      }
    }
    await act(async () => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <NfoExportPanel disabled={false} onBlockingChange={(value) => { blocking = value }} />
        </React.StrictMode>
      )
      await Promise.resolve()
    })
    const buttonByText = (pattern: RegExp) => renderer!.root.findAllByType('button')
      .find((button) => pattern.test(instanceText(button)))!
    await act(async () => { await buttonByText(/生成计划/u).props.onClick() })
    assert.equal(planned, 1)
    assert.ok(renderer!.root.findByProps({ 'aria-label': 'NFO 导出计划预览' }))

    await act(async () => { await buttonByText(/执行 2 个写入项/u).props.onClick() })
    assert.equal(blocking, true)
    await act(async () => {
      stateListener?.({
        taskId: 'task', state: 'finished', report: {
          taskId: 'task', startedAt: '', finishedAt: '', terminated: false,
          writtenCount: 2, skippedCount: 0, failedCount: 0, items: []
        }
      })
    })
    assert.equal(blocking, true, 'terminal report stays blocking until explicit confirmation')
  })

  it('discards a plan that returns after the storage panel has unmounted', async () => {
    const { default: NfoExportPanel } = await import('./NfoExportPanel')
    let resolvePlan!: (plan: NfoExportPlanPreview) => void
    const pendingPlan = new Promise<NfoExportPlanPreview>((resolve) => { resolvePlan = resolve })
    const discarded: string[] = []
    mockApi.nfoExport = {
      getOptions: async () => ({
        libraries: [{ id: 1, name: 'Main' }],
        profiles: [{
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable',
          supportsSampleReferences: true
        }],
        preferences: {
          libraryIds: [1], profileId: 'portable-v1', includeCover: true,
          includeFanart: true, includeSamples: false, includeActorAvatars: false
        }
      }),
      updatePreferences: async (value: unknown) => value,
      plan: async () => pendingPlan,
      discardPlan: async (planId: string) => { discarded.push(planId) },
      start: async () => ({ taskId: 'task' }),
      terminate: async () => undefined,
      onProgress: () => () => undefined,
      onState: () => () => undefined
    }
    await act(async () => {
      renderer = TestRenderer.create(
        <NfoExportPanel disabled={false} onBlockingChange={() => undefined} />
      )
      await Promise.resolve()
    })
    const generate = renderer!.root.findAllByType('button').find((button) =>
      instanceText(button).includes('生成计划')
    )!
    act(() => { generate.props.onClick() })
    act(() => { renderer!.unmount() })
    renderer = null
    await act(async () => {
      resolvePlan(returnedPlan())
      await pendingPlan
      await new Promise<void>((resolve) => setImmediate(resolve))
    })

    assert.ok(discarded.length >= 1)
    assert.equal(discarded.every((planId) =>
      planId === '00000000-0000-4000-8000-000000000001'), true)
  })

  it('terminates an export whose start result returns after unmount', async () => {
    const { default: NfoExportPanel } = await import('./NfoExportPanel')
    let resolveStart!: (result: { taskId: string }) => void
    const pendingStart = new Promise<{ taskId: string }>((resolve) => { resolveStart = resolve })
    const terminated: string[] = []
    mockApi.nfoExport = {
      getOptions: async () => ({
        libraries: [{ id: 1, name: 'Main' }],
        profiles: [{
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable',
          supportsSampleReferences: true
        }],
        preferences: {
          libraryIds: [1], profileId: 'portable-v1', includeCover: true,
          includeFanart: true, includeSamples: false, includeActorAvatars: false
        }
      }),
      updatePreferences: async (value: unknown) => value,
      plan: async () => returnedPlan(),
      discardPlan: async () => undefined,
      start: async () => pendingStart,
      terminate: async (taskId: string) => { terminated.push(taskId) },
      onProgress: () => () => undefined,
      onState: () => () => undefined
    }
    await act(async () => {
      renderer = TestRenderer.create(
        <NfoExportPanel disabled={false} onBlockingChange={() => undefined} />
      )
      await Promise.resolve()
    })
    const buttonByText = (pattern: RegExp) => renderer!.root.findAllByType('button')
      .find((button) => pattern.test(instanceText(button)))!
    await act(async () => {
      buttonByText(/生成计划/u).props.onClick()
      await new Promise<void>((resolve) => setImmediate(resolve))
    })
    act(() => { buttonByText(/执行 2 个写入项/u).props.onClick() })
    act(() => { renderer!.unmount() })
    renderer = null
    await act(async () => {
      resolveStart({ taskId: 'late-task' })
      await pendingStart
      await new Promise<void>((resolve) => setImmediate(resolve))
    })

    assert.deepEqual(terminated, ['late-task'])
  })
})
