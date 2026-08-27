import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { LibraryScanAudit, LibraryScanSummary } from '@shared/libraryTypes'

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
  unrecognized?: string[]
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
  it('keeps cached unrecognized files actionable when the matching audit is unavailable', async () => {
    await renderPanel({
      scanSummary: summary(),
      scanAudit: null,
      unrecognized: ['D:\\Downloads\\UNKNOWN.mp4']
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /UNKNOWN\.mp4/)
    assert.match(output, /无法识别番号/)
    assert.match(output, /异常与待办.*1/s)
  })

  it('does not describe current scan failures as resolved', async () => {
    await renderPanel({
      scanSummary: summary({ status: 'completed_with_errors', scannedFiles: 1, failedFiles: 1 }),
      scanAudit: audit([
        {
          outcome: 'strm_failure',
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
      scanAudit: audit([{ outcome: 'unrecognized', sourceKind: 'local', filePath }]),
      unrecognized: [filePath]
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
