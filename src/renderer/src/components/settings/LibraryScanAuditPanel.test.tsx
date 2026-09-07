import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type {
  LibraryScanAudit,
  LibraryScanLatestSnapshot,
  LibraryScanSummary
} from '@shared/libraryTypes'
import type { PendingItemKey } from '../../listView/pendingRoutes'

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
  unrecognized = [],
  currentPendingIdentityIds = new Set(),
  currentPendingScrapeIds = new Set(),
  onOpenPending = () => undefined
}: {
  scanSummary: LibraryScanSummary
  scanAudit: LibraryScanAudit | null
  unrecognized?: LibraryScanLatestSnapshot['unrecognized']
  currentPendingIdentityIds?: Set<number>
  currentPendingScrapeIds?: Set<number>
  onOpenPending?: (target: PendingItemKey) => void
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
        currentPendingIdentityIds={currentPendingIdentityIds}
        currentPendingScrapeIds={currentPendingScrapeIds}
        onSelect={() => undefined}
        onResolvedUnrecognized={() => undefined}
        onOpenVideo={() => undefined}
        onOpenPending={onOpenPending}
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

  it('shows an NFO identity conflict as a secondary scan disposition and opens the pending center', async () => {
    let opened: PendingItemKey | null = null
    await renderPanel({
      scanSummary: summary({ scannedFiles: 1, pendingScanResources: 1 }),
      scanAudit: {
        ...audit([
          {
            outcome: 'pending',
            rootId: 1,
            sourceKind: 'local',
            filePath: 'D:\\Media\\FILE-001.mp4',
            normalizedCode: null,
            groupId: null,
            addedToQueue: true,
            nfo: {
              disposition: 'identity-conflict',
              pendingIdentityId: 4
            }
          }
        ]),
        schemaVersion: 2
      },
      currentPendingIdentityIds: new Set([4]),
      onOpenPending: (target) => {
        opened = target
      }
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /NFO 身份冲突/)
    const process = renderer!.root
      .findAllByType('button')
      .find((candidate) => candidate.children.includes('处理待办'))
    assert.ok(process)
    act(() => process.props.onClick())
    assert.deepEqual(opened, { domain: 'scan', id: 'identity-4' })
  })

  it('routes a current NFO candidate to its scrape pending item', async () => {
    let opened: PendingItemKey | null = null
    await renderPanel({
      scanSummary: summary({ scannedFiles: 1, pendingScanResources: 1 }),
      scanAudit: {
        ...audit([
          {
            outcome: 'added',
            rootId: 1,
            sourceKind: 'local',
            filePath: 'D:\\Media\\FILE-003.mp4',
            videoId: 3,
            videoCode: 'FILE-003',
            resourceId: 3,
            resourceKind: 'local',
            createdVideo: true,
            nfo: {
              disposition: 'pending-candidate',
              pendingScrapeId: 8
            }
          }
        ]),
        schemaVersion: 2
      },
      currentPendingScrapeIds: new Set([8]),
      onOpenPending: (target) => {
        opened = target
      }
    })

    const process = renderer!.root
      .findAllByType('button')
      .find((candidate) => candidate.children.includes('处理待办'))
    assert.ok(process)
    act(() => process.props.onClick())
    assert.deepEqual(opened, { domain: 'scrape', id: '8' })
  })

  it('shows historical NFO pending dispositions as resolved when their current rows are gone', async () => {
    await renderPanel({
      scanSummary: summary({ scannedFiles: 1, pendingScanResources: 1 }),
      scanAudit: {
        ...audit([
          {
            outcome: 'added',
            rootId: 1,
            sourceKind: 'local',
            filePath: 'D:\\Media\\FILE-002.mp4',
            videoId: 2,
            videoCode: 'FILE-002',
            resourceId: 2,
            resourceKind: 'local',
            createdVideo: true,
            nfo: {
              disposition: 'pending-candidate',
              pendingScrapeId: 8
            }
          }
        ]),
        schemaVersion: 2
      }
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /NFO 候选待确认/)
    assert.match(output, /已处理/)
    assert.equal(
      renderer!.root
        .findAllByType('button')
        .some((candidate) => candidate.children.includes('处理待办')),
      false
    )
  })

  it('keeps the attention badge equal to the visible list when only an NFO warning exists', async () => {
    await renderPanel({
      scanSummary: summary({ scannedFiles: 1 }),
      scanAudit: {
        ...audit([
          {
            outcome: 'added',
            rootId: 1,
            sourceKind: 'local',
            filePath: 'D:\\Media\\WARN-001.mp4',
            videoId: 3,
            videoCode: 'WARN-001',
            resourceId: 3,
            resourceKind: 'local',
            createdVideo: true,
            nfo: {
              disposition: 'warning',
              warnings: [{ code: 'nfo-warning', message: '远程图片已忽略' }]
            }
          }
        ]),
        schemaVersion: 2
      }
    })

    const output = JSON.stringify(renderer?.toJSON())
    assert.match(output, /异常与待办.*1/s)
    assert.equal(
      renderer!.root
        .findAllByProps({ 'data-status': 'muted' })
        .some((pill) => pill.children.join('') === '1 项'),
      true
    )
    assert.match(output, /远程图片已忽略/)
  })
})
