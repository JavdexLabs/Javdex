import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type {
  LibraryScanAudit,
  LibraryScanLatestSnapshot,
  LibraryScanSummary
} from '@shared/libraryTypes'
import { buildScanAuditViewItems } from '@shared/scanAuditView'
import type { ScanAuditSnapshotIdentity, ScanAuditViewQuery } from '@shared/scanAuditReadTypes'
import type { PendingItemKey } from '../../listView/pendingRoutes'

let fixtureAudit: LibraryScanAudit | null = null
let fixtureUnrecognized: LibraryScanLatestSnapshot['unrecognized'] = []
function getAuditViewPage(snapshot: ScanAuditSnapshotIdentity, query: ScanAuditViewQuery) {
  const items = buildScanAuditViewItems({ audit: fixtureAudit, unrecognized: fixtureUnrecognized,
    activeTab: query.tab, outcome: query.outcome ?? 'all', changesFilter: query.changesFilter ?? 'all' })
  const offset = query.offset ?? 0
  return Promise.resolve({ snapshot, items: items.slice(offset, offset + 100), total: items.length,
    limit: 100, offset, anchorOffset: null, auditAvailable: fixtureAudit !== null,
    attentionBadgeCount: buildScanAuditViewItems({ audit: fixtureAudit, unrecognized: fixtureUnrecognized,
      activeTab: 'failed', outcome: 'all', changesFilter: 'all' }).length })
}

let presentIds = new Set<number>()
let presentIdentities = new Set<number>()
let presentGroups = new Set<number>()
const presenceRequests: number[][] = []

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    api: {
      scan: { getAuditViewPage, pendingAuditPresence: async (_libraryId:number, ids:{groupIds:number[];identityIds:number[];scrapeIds:number[]}) => {
        presenceRequests.push([...ids.groupIds,...ids.identityIds,...ids.scrapeIds]);
        return {groupIds:ids.groupIds.filter(id=>presentGroups.has(id)),identityIds:ids.identityIds.filter(id=>presentIdentities.has(id)),scrapeIds:ids.scrapeIds.filter(id=>presentIds.has(id))}
      }, revealAuditFile: async () => ({ ok: true }) },
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
  presenceRequests.length = 0
  presentIds = new Set()
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
  currentPendingGroupIds = new Set(),
  currentPendingIdentityIds = new Set(),
  currentPendingScrapeIds = new Set(),
  onOpenPending = () => undefined
}: {
  scanSummary: LibraryScanSummary
  scanAudit: LibraryScanAudit | null
  unrecognized?: LibraryScanLatestSnapshot['unrecognized']
  currentPendingGroupIds?: Set<number>
  currentPendingIdentityIds?: Set<number>
  currentPendingScrapeIds?: Set<number>
  onOpenPending?: (target: PendingItemKey) => void
}): Promise<void> {
  fixtureAudit = scanAudit
  fixtureUnrecognized = unrecognized
  presentIds = currentPendingScrapeIds
  presentIdentities = currentPendingIdentityIds
  presentGroups = currentPendingGroupIds
  const { default: LibraryScanAuditPanel } = await import('./LibraryScanAuditPanel')
  await act(async () => {
    renderer = TestRenderer.create(
      <LibraryScanAuditPanel
        summary={scanSummary}
        revision={1}
        onRefreshHistory={async () => undefined}
        selected={null}
        onSelect={() => undefined}
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
    await act(async () => allFilesTab.props.onClick())

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


it('limits a large failed audit to100 visible rows and queries only their pending IDs',async()=>{
  const files: LibraryScanAudit['files']=Array.from({length:201},(_,i)=>({
    outcome:'added',rootId:1,sourceKind:'local',filePath:`/synthetic/FILE-${i+1}.mp4`,videoId:i+1,videoCode:`FILE-${i+1}`,
    resourceId:i+1,resourceKind:'local',createdVideo:true,nfo:{disposition:'pending-candidate',pendingScrapeId:i+1}
  }))
  await renderPanel({scanSummary:summary({scannedFiles:201}),scanAudit:{...audit(files),schemaVersion:2},currentPendingScrapeIds:new Set([1,101,201])})
  assert.deepEqual(presenceRequests[0],Array.from({length:100},(_,i)=>i+1))
  assert.equal(renderer!.root.findAll(node=>node.props['data-audit-anchor']).length,100)
  const next=()=>renderer!.root.findAllByType('button').find(node=>node.children.includes('下一页'))!
  await act(async()=>next().props.onClick())
  assert.deepEqual(presenceRequests.at(-1),Array.from({length:100},(_,i)=>101+i))
  await act(async()=>next().props.onClick())
  assert.deepEqual(presenceRequests.at(-1),[201])
  assert.equal(renderer!.root.findAll(node=>node.props['data-audit-anchor']).length,1)
  assert.ok(presenceRequests.every(ids=>ids.length<=100))
})


it('routes all three kinds from one mixed pending presence response',async()=>{
  const opened:PendingItemKey[]=[]
  const files:LibraryScanAudit['files']=[
    {outcome:'added',rootId:1,sourceKind:'local',filePath:'/identity.mp4',videoId:1,videoCode:'IDENTITY',resourceId:1,resourceKind:'local',createdVideo:true,nfo:{disposition:'identity-conflict',pendingIdentityId:7}},
    {outcome:'added',rootId:1,sourceKind:'local',filePath:'/scrape.mp4',videoId:2,videoCode:'SCRAPE',resourceId:2,resourceKind:'local',createdVideo:true,nfo:{disposition:'pending-candidate',pendingScrapeId:8}}
  ]
  await renderPanel({scanSummary:summary(),scanAudit:{...audit(files),schemaVersion:2,pendingGroups:[{groupId:9,normalizedCode:'GROUP',resourceCount:1}]},currentPendingGroupIds:new Set([9]),currentPendingIdentityIds:new Set([7]),currentPendingScrapeIds:new Set([8]),onOpenPending:target=>opened.push(target)})
  assert.deepEqual(presenceRequests,[ [9,7,8] ])
  const buttons=renderer!.root.findAllByType('button').filter(node=>node.children.includes('处理待办'))
  assert.equal(buttons.length,3)
  act(()=>buttons.forEach(button=>button.props.onClick()))
  assert.deepEqual(opened,[{domain:'scan',id:'identity-7'},{domain:'scrape',id:'8'},{domain:'scan',id:'9'}])
})


it('keeps a stable audit anchor when a historical group is no longer pending',async()=>{
 await renderPanel({scanSummary:summary(),scanAudit:{...audit([]),pendingGroups:[{groupId:9,normalizedCode:'GONE',resourceCount:1}]}})
 assert.equal(renderer!.root.findAllByProps({'data-audit-anchor':'group:9'}).length,1)
 assert.equal(renderer!.root.findAllByType('button').filter(node=>node.children.includes('处理待办')).length,0)
 assert.match(JSON.stringify(renderer!.toJSON()),/已处理/)
})
