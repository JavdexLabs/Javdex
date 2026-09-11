import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  DEFAULT_MEDIA_LIBRARY_CONFIG,
  type MediaLibraryDetail
} from '@shared/mediaLibraryTypes'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { api: { scan: { revealAuditFile: async () => ({ ok: true }) } } }
})

let renderer: TestRenderer.ReactTestRenderer | null = null

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('')
}

afterEach(() => {
  renderer?.unmount()
  renderer = null
})

const library = {
  id: 1,
  name: '测试媒体库',
  icon: 'library',
  color: 'slate',
  position: 0,
  status: 'active',
  isDefault: true,
  revision: 1,
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
  config: { libraryId: 1, revision: 1, ...DEFAULT_MEDIA_LIBRARY_CONFIG },
  roots: [],
  rootCount: 0,
  activeRootCount: 0,
  pendingRemovalRootCount: 0,
  pendingCleanupJobCount: 0,
  pendingScanGroupCount: 0,
  disabledRootCount: 0,
  archivedRootCount: 0
} satisfies MediaLibraryDetail

describe('ScanSettingsTab', () => {
  it('builds domain-correct deep links for scan identities and scrape candidates', async () => {
    const { scanAuditPendingCenterPath } = await import('./MediaLibrarySettingsTabs')
    assert.equal(
      scanAuditPendingCenterPath(7, { domain: 'scan', id: 'identity-4' }),
      '/pending?type=scan&item=scan%3Aidentity-4&lib=7'
    )
    assert.equal(
      scanAuditPendingCenterPath(7, { domain: 'scrape', id: '8' }),
      '/pending?type=scrape&item=scrape%3A8'
    )
  })

  it('renders automatic local NFO import enabled by default and persists a switch change immediately', async () => {
    const { ScanSettingsTab } = await import('./MediaLibrarySettingsTabs')
    const updates: Array<[string, unknown]> = []
    act(() => {
      renderer = TestRenderer.create(
        <ScanSettingsTab
          libraryId={library.id}
          library={library}
          scan={{
            running: false,
            cancelling: false,
            activeRunId: null,
            progress: null,
            error: null,
            latest: null,
            start: async () => undefined,
            cancel: async () => undefined,
            refreshLatest: async () => undefined
          } as never}
          latestScanSummary={null}
          selectedScanMetric={null}
          setSelectedScanMetric={() => undefined}
          configDraft={DEFAULT_MEDIA_LIBRARY_CONFIG}
          updateConfigImmediately={async (key, value) => {
            updates.push([key, value])
          }}
          formDisabled={false}
          navigate={() => undefined}
        />
      )
    })

    const row = renderer!.root
      .findAllByType('label')
      .find((candidate) => nodeText(candidate).includes('自动导入本地 NFO'))
    assert.ok(row)
    const input = row.findByProps({ role: 'switch' })
    assert.equal(input.props.checked, true)

    await act(async () => {
      input.props.onChange({ target: { checked: false } })
      await Promise.resolve()
    })

    assert.deepEqual(updates, [['autoImportLocalNfo', false]])
  })
})

it('distinguishes scan history loading, failure with retry and an empty result', async () => {
  const { ScanSettingsTab } = await import('./MediaLibrarySettingsTabs')
  let retries = 0
  const render = (latestLoading: boolean, latestError: string | null) => (
    <ScanSettingsTab libraryId={library.id} library={library}
      scan={{running:false,cancelling:false,activeRunId:null,progress:null,error:null,latest:null,
        latestLoading,latestError,start:async()=>undefined,cancel:async()=>undefined,
        refreshLatest:async()=>{retries++}} as never}
      latestScanSummary={null} selectedScanMetric={null} setSelectedScanMetric={()=>undefined}
      configDraft={DEFAULT_MEDIA_LIBRARY_CONFIG} updateConfigImmediately={async()=>undefined}
      formDisabled={false} navigate={()=>undefined}/>
  )
  await act(async()=>{renderer=TestRenderer.create(render(true,null))})
  assert.match(nodeText(renderer!.root),/正在加载扫描记录/)
  assert.doesNotMatch(nodeText(renderer!.root),/尚无扫描记录/)
  await act(async()=>renderer!.update(render(false,'injected')))
  assert.match(nodeText(renderer!.root),/扫描记录加载失败：injected/)
  const retry=renderer!.root.findAllByType('button').find(node=>nodeText(node)==='重试')
  assert.ok(retry)
  await act(async()=>retry.props.onClick());assert.equal(retries,1)
  await act(async()=>renderer!.update(render(false,null)))
  assert.match(nodeText(renderer!.root),/尚无扫描记录/)
})
it('feeds summary-only history into the paged panel and refreshes pages when the header revision advances',async()=>{
 const {ScanSettingsTab}=await import('./MediaLibrarySettingsTabs')
 const summary:import('@shared/libraryTypes').LibraryScanSummary={libraryId:1,runId:'header-only',configRevision:1,trigger:'manual',startedAt:'2026-09-11T00:00:00Z',finishedAt:'2026-09-11T00:01:00Z',status:'success',scannedFiles:0,resourcesAdded:0,resourcesUpdated:0,resourcesRemoved:0,primaryResourcesPromoted:0,videosDeleted:0,skippedFiles:0,failedFiles:0,pendingScanGroups:0,pendingScanResources:0,offlineFolders:[],errorSummary:null}
 const calls:unknown[]=[]
 window.api.scan.getLatest=async()=>{throw new Error('Full snapshot forbidden')}
 window.api.scan.getAuditViewPage=async(snapshot,query)=>{calls.push({snapshot,query});return{snapshot,auditAvailable:false,items:[],total:0,attentionBadgeCount:0,limit:100,offset:0,anchorOffset:null}}
 window.api.scan.pendingAuditPresence=async(_libraryId,ids)=>ids
 window.setTimeout=setTimeout as unknown as typeof window.setTimeout
 window.clearTimeout=clearTimeout as unknown as typeof window.clearTimeout
 window.requestAnimationFrame=callback=>setTimeout(()=>callback(0),0) as unknown as number
 window.cancelAnimationFrame=id=>clearTimeout(id)
 const render=(revision:number)=><ScanSettingsTab libraryId={1} library={library}
  scan={{running:false,cancelling:false,activeRunId:null,progress:null,error:null,latest:{summary,snapshot:null,unrecognizedCount:0},latestRevision:revision,latestLoading:false,latestError:null,result:null,start:async()=>undefined,cancel:async()=>undefined,refreshLatest:async()=>undefined}}
  latestScanSummary={summary} selectedScanMetric={null} setSelectedScanMetric={()=>undefined}
  configDraft={DEFAULT_MEDIA_LIBRARY_CONFIG} updateConfigImmediately={async()=>undefined} formDisabled={false} navigate={()=>undefined}/>
 await act(async()=>{renderer=TestRenderer.create(render(1));await new Promise(resolve=>setTimeout(resolve,20))})
 assert.ok(calls.length>0)
 const first=calls.length
 await act(async()=>{renderer!.update(render(2));await new Promise(resolve=>setTimeout(resolve,20))})
 assert.ok(calls.length>first)
 for(const call of calls){const request=call as {snapshot:{runId:string};query:{limit:number}};assert.equal(request.snapshot.runId,'header-only');assert.equal(request.query.limit,100)}
 assert.match(nodeText(renderer!.root),/审计|明细/)
})
