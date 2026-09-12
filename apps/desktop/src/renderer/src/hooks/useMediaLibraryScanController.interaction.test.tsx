import assert from 'node:assert/strict'
import {afterEach,it} from 'node:test'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import type {ScanAuditReadHeader} from '@shared/scanAuditReadTypes'
import type {LibraryScanEvent,ScanCompletionResult} from '@shared/libraryTypes'

type Request={id:number;resolve:(value:ScanAuditReadHeader)=>void;reject:(error:Error)=>void}
const requests:Request[]=[]
let stateListener:((event:LibraryScanEvent)=>void)|undefined
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:{api:{scan:{
 getLatest:()=>{throw new Error('Full scan snapshot forbidden')},
 getAuditHeader:(id:number)=>new Promise<ScanAuditReadHeader>((resolve,reject)=>requests.push({id,resolve,reject})),
 onProgress:()=>()=>undefined,onStateChanged:(listener:(event:LibraryScanEvent)=>void)=>{
  stateListener=listener;return()=>{if(stateListener===listener)stateListener=undefined}
 }
}}}})
let renderer:TestRenderer.ReactTestRenderer|undefined
let client:QueryClient
let current:ReturnType<typeof import('./useMediaLibraryScanController').useMediaLibraryScanController>
let hook:typeof import('./useMediaLibraryScanController').useMediaLibraryScanController
function Probe({id,enabled}:{id:number;enabled:boolean}):null{current=hook(id,{loadLatest:enabled});return null}
async function show(id:number,enabled:boolean){
 hook=(await import('./useMediaLibraryScanController')).useMediaLibraryScanController
 client??=new QueryClient({defaultOptions:{queries:{retry:false}}})
 await act(async()=>{const node=<QueryClientProvider client={client}><Probe id={id} enabled={enabled}/></QueryClientProvider>
  if(renderer)renderer.update(node);else renderer=TestRenderer.create(node)
 })
}
async function flush(){await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10))})}
function currentRun(){return current.latest?.snapshot?.runId}
function snapshot(runId:string):ScanAuditReadHeader{return {summary:null,snapshot:{libraryId:1,runId,finishedAt:'now'},unrecognizedCount:1}}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;client?.clear();requests.length=0})
it('does not load hidden scan history, including manual refresh and invalidation, and releases completed data',async()=>{
 await show(1,false);assert.equal(requests.length,0);assert.equal(current.latestLoading,false)
 await act(async()=>{await current.refreshLatest();await client.invalidateQueries()});assert.equal(requests.length,0)
 await show(1,true);assert.equal(requests.length,1);assert.equal(current.latestLoading,true)
 requests[0].resolve(snapshot('first'));await flush();assert.equal(currentRun(),'first')
 const oldRefresh = current.refreshLatest
 await show(1,false);await flush();assert.equal(current.latest,null)
 await act(async()=>{void oldRefresh()});assert.equal(requests.length,1)
 assert.equal(client.getQueryCache().find({queryKey:['media-library-scan-header',1],exact:true}),undefined)
 await show(1,true);assert.equal(requests.length,2);assert.equal(current.latest,null)
 requests[1].resolve(snapshot('fresh'));await flush();assert.equal(currentRun(),'fresh')
})
it('discards pending results after leaving and re-entering or switching libraries',async()=>{
 await show(1,true);await show(1,false);await show(1,true)
 assert.equal(requests.length,2)
 requests[0].resolve(snapshot('stale'));await flush();assert.equal(current.latest,null)
 await show(2,true);assert.equal(requests[2].id,2)
 requests[1].resolve(snapshot('old-library'));await flush();assert.equal(current.latest,null)
 requests[2].resolve(snapshot('library-two'));await flush();assert.equal(currentRun(),'library-two')
})
it('exposes history load errors and retries without treating failure as an empty history',async()=>{
 await show(1,true);requests[0].reject(new Error('injected'));await flush()
 assert.equal(current.latestError,'injected');assert.equal(current.latestLoading,false)
 let retry:Promise<void>|undefined
 await act(async()=>{retry=current.refreshLatest()});assert.equal(requests.length,2)
 requests[1].resolve(snapshot('recovered'));await act(async()=>retry);await flush()
 assert.equal(current.latestError,null);assert.equal(currentRun(),'recovered')
})
it('advances page refresh revision even when the returned header is unchanged',async()=>{
 await show(1,true);const value=snapshot('same')
 requests[0].resolve(value);await flush();const first=current.latestRevision
 assert.ok(first>0)
 let refreshing:Promise<void>|undefined
 await act(async()=>{refreshing=current.refreshLatest()})
 requests[1].resolve(value);await act(async()=>refreshing);await flush()
 assert.ok(current.latestRevision>first)
 assert.equal(currentRun(),'same')
})
function completion(runId:string):ScanCompletionResult{return {
 libraryId:1,runId,scannedFiles:600000,imported:0,skipped:0,skippedShort:0,failed:600000,
 pendingGroups:0,pendingResources:0,relocated:0,refreshed:0,removed:0,promoted:0,deletedVideos:0,
 offlineFolders:[],unrecognizedCount:600000,strmFailures:[],omittedStrmFailures:0
}}
it('accepts compact IPC completion without loading full results or hidden audit history',async()=>{
 const value=completion('ipc-compact')
 window.api.scan.run=async id=>{assert.equal(id,1);return value}
 await show(1,false)
 await act(async()=>current.start())
 assert.equal(current.result,value);assert.equal(current.running,false);assert.equal(current.error,null)
 assert.equal(current.result?.unrecognizedCount,600000)
 assert.equal(Object.hasOwn(current.result!,'unrecognizedFiles'),false)
 assert.equal(Object.hasOwn(current.result!,'newCodes'),false)
 assert.equal(requests.length,0)
})
it('accepts compact completion events and ignores a duplicate IPC completion for the same run',async()=>{
 const value=completion('event-compact')
 let resolve!:(result:ScanCompletionResult)=>void
 window.api.scan.run=()=>new Promise<ScanCompletionResult>(done=>{resolve=done})
 await show(1,false)
 let started:Promise<void>|undefined
 await act(async()=>{started=current.start()})
 await act(async()=>stateListener?.({phase:'started',libraryId:1,runId:value.runId,trigger:'manual'}))
 await act(async()=>stateListener?.({phase:'completed',libraryId:1,runId:value.runId,trigger:'manual',result:value}))
 assert.equal(current.result,value);assert.equal(current.running,false)
 resolve({...value,unrecognizedCount:0})
 await act(async()=>started)
 assert.equal(current.result,value);assert.equal(current.result?.unrecognizedCount,600000)
 assert.equal(requests.length,0)
})
it('retries a failed page through the real header controller without issuing the old run again',async()=>{
 hook=(await import('./useMediaLibraryScanController')).useMediaLibraryScanController
 const Panel=(await import('../components/settings/LibraryScanAuditPanel')).default
 const summary:import('@shared/libraryTypes').LibraryScanSummary={libraryId:1,runId:'old',configRevision:1,trigger:'manual',startedAt:'2026-09-11T00:00:00Z',finishedAt:'2026-09-11T00:01:00Z',status:'success',scannedFiles:0,resourcesAdded:0,resourcesUpdated:0,resourcesRemoved:0,primaryResourcesPromoted:0,videosDeleted:0,skippedFiles:0,failedFiles:0,pendingScanGroups:0,pendingScanResources:0,offlineFolders:[],errorSummary:null}
 const views:string[]=[]
 window.api.scan.getAuditViewPage=async(identity)=>{views.push(identity.runId);if(views.length===1)throw new Error('page failed');return{snapshot:identity,auditAvailable:true,items:[],total:0,attentionBadgeCount:0,limit:100,offset:0,anchorOffset:null}}
 window.api.scan.pendingAuditPresence=async(_id,ids)=>ids
 window.requestAnimationFrame=callback=>setTimeout(()=>callback(0),0) as unknown as number
 window.cancelAnimationFrame=id=>clearTimeout(id)
 const noSelect=()=>undefined
 function Integrated(){current=hook(1,{loadLatest:true});return current.latest?.summary?<Panel summary={current.latest.summary} revision={current.latestRevision} onRefreshHistory={current.refreshLatest} selected={null} onSelect={noSelect} onOpenVideo={noSelect} onOpenPending={noSelect}/>:null}
 client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><Integrated/></QueryClientProvider>)})
 requests[0].resolve({summary,snapshot:{libraryId:1,runId:'old',finishedAt:summary.finishedAt},unrecognizedCount:0});await flush()
 assert.deepEqual(views,['old'])
 const retry=renderer!.root.findAllByType('button').find(node=>node.children.includes('重试'))
 assert.ok(retry)
 await act(async()=>retry.props.onClick());assert.equal(requests.length,2)
 requests[1].resolve({summary:{...summary,runId:'next'},snapshot:{libraryId:1,runId:'next',finishedAt:summary.finishedAt},unrecognizedCount:0});await flush()
 assert.deepEqual(views,['old','next'])
})
