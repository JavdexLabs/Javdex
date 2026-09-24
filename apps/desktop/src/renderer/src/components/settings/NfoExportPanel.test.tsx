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
    assert.match(instanceText(buttons[0]), /停止/u)
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
    const discarded: string[] = []
    let blocking = false
    mockApi.nfoExport = {
      getOptions: async () => ({
        libraries: [{ id: 1, name: 'Main' }],
        profiles: [{
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable'
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
      discardPlan: async (id: string) => { discarded.push(id) },
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
    await act(async () => { await buttonByText(/预览导出/u).props.onClick() })
    assert.equal(planned, 1)
    assert.ok(renderer!.root.findByProps({ 'aria-label': 'NFO 导出计划预览' }))

    const cover = renderer!.root.findAllByType('input')[1]
    await act(async () => { cover.props.onChange({ target: { checked: false } }) })
    assert.deepEqual(discarded, [returnedPlan().planId])
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': 'NFO 导出计划预览' }).length, 0)
    assert.match(instanceText(renderer!.root), /设置已更改，请重新预览/u)
    await act(async () => { await buttonByText(/预览导出/u).props.onClick() })

    await act(async () => { await buttonByText(/导出 2 个文件/u).props.onClick() })
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
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable'
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
      instanceText(button).includes('预览导出')
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
          id: 'portable-v1', label: '通用 / Kodi', description: 'Portable'
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
      buttonByText(/预览导出/u).props.onClick()
      await new Promise<void>((resolve) => setImmediate(resolve))
    })
    act(() => { buttonByText(/导出 2 个文件/u).props.onClick() })
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

describe('NFO export preview details', () => {
  it('counts only new and replaced artwork in the writing breakdown', async () => {
    const { PlanPreview } = await import('./NfoExportPanel')
    const preview = returnedPlan()
    preview.files = [
      { ...preview.files[0], action: 'skip-existing' },
      { ...preview.files[0], id: 'sample1', kind: 'sample', action: 'create' },
      { ...preview.files[0], id: 'sample2', kind: 'sample', action: 'replace' },
      { ...preview.files[0], id: 'sample3', kind: 'sample', action: 'skip-existing' },
      { ...preview.files[0], id: 'cover', kind: 'cover', action: 'unavailable' }
    ]
    Object.assign(preview.summary, { fileCount: 5, createCount: 1, replaceCount: 1, skipCount: 2, unavailableCount: 1, sampleCount: 3 })
    act(() => { renderer = TestRenderer.create(<PlanPreview preview={preview} />) })
    assert.equal(instanceText(renderer!.root.findByProps({ 'aria-label': '本次写入组成' })), '本次写入：样张备份 2')
    preview.files = preview.files.map((file) => ({ ...file, action: 'skip-existing' }))
    Object.assign(preview.summary, { createCount: 0, replaceCount: 0, skipCount: 5, unavailableCount: 0 })
    act(() => { renderer!.update(<PlanPreview preview={preview} />) })
    assert.match(instanceText(renderer!.root), /无需写入.*已有文件已保留/u)
    assert.equal(renderer!.root.findAllByProps({ 'aria-label': '本次写入组成' }).length, 0)
  })

  it('distinguishes stopped, partial and empty reports and exposes stop errors in the dialog', async () => {
    const { ExportProgressModal } = await import('./NfoExportPanel')
    const state = { ...running(), error: '连接暂时不可用' }
    act(() => { renderer = TestRenderer.create(<ExportProgressModal modal={state} onTerminate={async () => undefined} onClose={() => undefined} />) })
    assert.equal(instanceText(renderer!.root.findByProps({ role: 'alert' })), state.error)
    assert.match(instanceText(renderer!.root), /重试停止/u)
    for (const [terminated, writtenCount, failedCount, title] of [
      [true, 1, 0, '已停止导出'], [false, 1, 1, '部分导出完成'],
      [false, 0, 1, '未写入文件'], [false, 1, 0, '导出完成']
    ] as const) {
      const modal = { ...running(), report: { taskId: 'task', startedAt: '', finishedAt: '', terminated, writtenCount, failedCount, skippedCount: 0, items: [] } }
      act(() => { renderer!.update(<ExportProgressModal modal={modal} onTerminate={async () => undefined} onClose={() => undefined} />) })
      assert.equal(instanceText(renderer!.root.findByType('h3')), title)
      assert.equal(instanceText(renderer!.root).includes('前往目标软件刷新'), writtenCount > 0)
    }
  })

  it('mounts only the opened page of a large warning list and keeps every warning reachable', async () => {
    const { PlanPreview } = await import('./NfoExportPanel')
    const preview = returnedPlan()
    preview.warnings = Array.from({ length: 749 }, (_, index) => `提示 ${index + 1}`)
    preview.summary.warningCount = preview.warnings.length
    act(() => { renderer = TestRenderer.create(<PlanPreview preview={preview} />) })
    assert.equal(renderer!.root.findAllByType('li').length, 0)
    assert.equal(instanceText(renderer!.root).includes(preview.files[0].displayName), false)
    const details = renderer!.root.findAllByType('details')[0]
    act(() => { details.props.onToggle({ currentTarget: { open: true } }) })
    assert.equal(renderer!.root.findAllByType('li').length, 50)
    const visited: string[] = []
    for (let page = 0; page < 15; page += 1) {
      visited.push(...renderer!.root.findAllByType('li').map(instanceText))
      const next = renderer!.root.findAllByType('button').find((button) => instanceText(button) === '下一页')!
      assert.equal(next.props.disabled, page === 14)
      if (page < 14) act(() => { next.props.onClick() })
    }
    assert.deepEqual(visited, preview.warnings)
    act(() => { details.props.onToggle({ currentTarget: { open: false } }) })
    assert.equal(renderer!.root.findAllByType('li').length, 0)
    act(() => { renderer!.root.findAllByType('details')[1].props.onToggle({ currentTarget: { open: true } }) })
    assert.match(instanceText(renderer!.root), /ABC-001 \/ ABC-001.nfoNFO新建/u)
  })
})
