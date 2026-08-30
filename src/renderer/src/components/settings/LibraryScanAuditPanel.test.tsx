import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type {
  LibraryScanAudit,
  LibraryScanLatestSnapshot,
  LibraryScanSummary
} from '@shared/libraryTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      scan: { revealAuditFile: async () => ({ ok: true }) },
      videos: { list: async () => ({ items: [], total: 0 }) }
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout
  }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

function summary(overrides: Partial<LibraryScanSummary> = {}): LibraryScanSummary {
  return {
    libraryId: 1,
    runId: 'run-1',
    configRevision: 1,
    trigger: 'manual',
    startedAt: '2026-08-27T01:00:00.000Z',
    finishedAt: '2026-08-27T01:00:05.000Z',
    status: 'success',
    scannedFiles: 0,
    resourcesAdded: 0,
    resourcesUpdated: 0,
    resourcesRemoved: 0,
    primaryResourcesPromoted: 0,
    videosDeleted: 0,
    skippedFiles: 0,
    failedFiles: 0,
    pendingScanGroups: 0,
    pendingScanResources: 0,
    offlineFolders: [],
    errorSummary: null,
    ...overrides
  }
}

function audit(files: LibraryScanAudit['files']): LibraryScanAudit {
  return {
    schemaVersion: 1,
    libraryId: 1,
    runId: 'run-1',
    configRevision: 1,
    trigger: 'manual',
    startedAt: '2026-08-27T01:00:00.000Z',
    finishedAt: '2026-08-27T01:00:05.000Z',
    status: 'success',
    files,
    removedResources: [],
    promotedResources: [],
    deletedVideos: [],
    pendingGroups: []
  }
}

async function renderPanel({
  scanSummary,
  scanAudit,
  unrecognized = []
}: {
  scanSummary: LibraryScanSummary
  scanAudit: LibraryScanAudit | null
  unrecognized?: LibraryScanLatestSnapshot['unrecognized']
}): Promise<void> {
  const { default: LibraryScanAuditPanel } = await import('./LibraryScanAuditPanel')
  act(() => {
    renderer = TestRenderer.create(
      <LibraryScanAuditPanel
        summary={scanSummary}
        audit={scanAudit}
        selected={null}
        unrecognized={unrecognized}
        currentPendingGroupIds={new Set()}
        onSelect={() => undefined}
        onResolvedUnrecognized={() => undefined}
        onOpenVideo={() => undefined}
        onOpenPending={() => undefined}
      />
    )
  })
}

describe('LibraryScanAuditPanel', () => {
  it('defaults to the attention tab even when the latest scan has no issues', async () => {
    await renderPanel({
      scanSummary: summary(),
      scanAudit: audit([])
    })

    const attentionTab = renderer!.root
      .findAllByType('button')
      .find((button) =>
        button.findAllByType('span').some((span) => span.children.includes('异常与待办'))
      )
    assert.ok(attentionTab)
    assert.match(attentionTab.props.className, /tabBtnActive/)
    assert.match(JSON.stringify(renderer?.toJSON()), /异常与待办清单/)
  })

  it('keeps cached unrecognized files visible with their root-scoped resolution controls', async () => {
    await renderPanel({
      scanSummary: summary(),
      scanAudit: null,
      unrecognized: [{ rootId: 1, filePath: 'D:\\Downloads\\UNKNOWN.mp4' }]
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /UNKNOWN\.mp4/)
    assert.match(output, /无法识别番号/)
    assert.match(output, /异常与待办.*1/s)
    assert.match(output, /输入番号/)
  })

  it('does not describe current scan failures as resolved', async () => {
    await renderPanel({
      scanSummary: summary({ status: 'completed_with_errors', scannedFiles: 1, failedFiles: 1 }),
      scanAudit: audit([
        {
          outcome: 'strm_failure',
          rootId: 1,
          sourceKind: 'strm',
          filePath: 'D:\\Media\\BROKEN.strm',
          failureCode: 'read_failed',
          message: '读取失败'
        }
      ])
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /STRM 失败/)
    assert.match(output, /读取失败/)
    assert.doesNotMatch(output, /已处理/)
  })

  it('offers a processing jump for cached unrecognized rows in the all-files tab', async () => {
    const filePath = 'D:\\Downloads\\UNKNOWN.mp4'
    await renderPanel({
      scanSummary: summary({ scannedFiles: 1, failedFiles: 1 }),
      scanAudit: audit([{ outcome: 'unrecognized', rootId: 1, sourceKind: 'local', filePath }]),
      unrecognized: [{ rootId: 1, filePath }]
    })

    const allFilesTab = renderer!.root
      .findAllByType('button')
      .find((button) =>
        button.findAllByType('span').some((span) => span.children.includes('全部文件'))
      )
    assert.ok(allFilesTab)
    act(() => allFilesTab.props.onClick())

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /处理/)
  })
})
