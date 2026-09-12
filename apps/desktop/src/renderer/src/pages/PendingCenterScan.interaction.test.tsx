import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { actressKeys } from '../query/queryKeys'
import { pendingCenterPath, pendingItemKey, parsePendingCenterSearch } from '../listView/pendingRoutes'
import type { ElectronApi } from '../../../preload/index'
import type { PendingScanQueuePage, PendingScanQueueQuery, PendingScanGroup } from '@shared/libraryTypes'
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const pages: PendingScanQueueQuery[] = []
const details: Array<{id:number;libraryId:number} & ReturnType<typeof deferred<PendingScanGroup | null>>> = []
let total = 120, failPage = false, failCount = false, failLibraries = false, identityMode = false
const identityCalls: number[] = []
let conflictReads = 0, conflictCount = 17, failConflictCount = false
let holdOffset: number | undefined
const heldPages: Array<{value:PendingScanQueuePage} & ReturnType<typeof deferred<PendingScanQueuePage>>> = []
let location = ''
let navigate: NavigateFunction
const fakeApi = {
  mediaLibraries: { list: async () => { if(failLibraries)throw new Error('libraries failure');return [{id:1,name:'First'},{id:2,name:'Second'}] } },
  actressScrape: { listConflicts: () => { throw new Error('Full actress queue is forbidden') }, pageConflicts: async () => {conflictReads++;return {items:[],total:0,offset:0}}, conflictSummary: async () => { if(failConflictCount)throw new Error('summary failure');return {groupCount:conflictCount} } },
  scrape: { countPending: async () => 0, pagePending: async () => ({items:[],total:0,offset:0}) },
  scan: {
    listPending: () => { throw new Error('Unbounded scan inbox') },
    listPendingResourceIdentities: () => { throw new Error('Unbounded identities') },
    countPendingQueue: async () => { if(failCount)throw new Error('count failure');return total },
    pagePendingQueue: async (query:PendingScanQueueQuery) => {
      pages.push(query)
      if(failPage){failPage=false;throw new Error('page failure')}
      const anchor=query.anchor?.id
      const offset=anchor && anchor<=total ? Math.floor((anchor-1)/50)*50 : Math.min(query.offset??0,Math.max(0,Math.floor((total-1)/50)*50))
      if(identityMode)return {total:1,offset:0,items:[{kind:'identity',id:4,libraryId:2,revision:3,label:'FILE ↔ NFO',displayName:'file.mp4'}]}
      const value:PendingScanQueuePage={total,offset,items:Array.from({length:Math.min(50,total-offset)},(_,i)=>({kind:'group',id:offset+i+1,libraryId:query.libraryId??1,revision:1,label:`GROUP-${offset+i+1}`,resourceCount:2}))}
      if(holdOffset===offset){holdOffset=undefined;const held={value,...deferred<PendingScanQueuePage>()};heldPages.push(held);return held.promise}
      return value
    },
    getPendingIdentity: async (libraryId:number,id:number) => { identityCalls.push(libraryId,id); return {id,libraryId,rootId:1,sourceKind:'local',targetKind:null,targetDisplay:null,displayName:'file.mp4',filenameCode:'FILE',nfoCode:'NFO',revision:3,createdAt:'2026',updatedAt:'2026'} },
    getPendingGroup: (libraryId:number,id:number) => { const request={id,libraryId,...deferred<PendingScanGroup|null>()};details.push(request);return request.promise }
  }
} as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:fakeApi})})
let renderer:TestRenderer.ReactTestRenderer|undefined
let client:QueryClient|undefined
function Probe():null {navigate=useNavigate();location=useLocation().search;return null}
async function settle():Promise<void>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})}
async function mount(url='/pending?type=scan'):Promise<void>{
  const Page=(await import('./PendingCenterPage')).default
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client!}><MemoryRouter initialEntries={[url]}><Probe/><Page/></MemoryRouter></QueryClientProvider>)})
  await settle();await settle()
}
function content(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:content(child)).join('')}
async function click(label:string):Promise<void>{const button=renderer!.root.findAllByType('button').find(node=>content(node)===label);assert.ok(button,label);assert.ok(!button.props.disabled);await act(async()=>button.props.onClick());await settle();await settle()}
afterEach(async()=>{await act(async()=>renderer?.unmount());client?.clear();renderer=undefined;client=undefined;pages.length=0;details.length=0;total=120;failPage=false;failCount=false;failLibraries=false;identityMode=false;identityCalls.length=0;conflictReads=0;conflictCount=17;failConflictCount=false;holdOffset=undefined;heldPages.length=0})
it('locates scan anchors, reads only selected details and ignores late details after paging',async()=>{
  await mount(pendingCenterPath({type:'scan',item:pendingItemKey('scan',110),libraryId:2}))
  assert.deepEqual(pages[0].anchor,{kind:'group',id:110})
  assert.equal(pages[0].libraryId,2)
  assert.deepEqual(details.map(({id,libraryId})=>({id,libraryId})),[{id:110,libraryId:2}])
  await click('上一页')
  assert.ok(location.includes('scanOffset=50'));assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).libraryId,2)
  assert.equal(details.at(-1)!.id,51)
  await act(async()=>details[0].resolve({id:110,libraryId:2,revision:1,normalizedCode:'LATE',resources:[],createdAt:'2026',updatedAt:'2026'}));await settle()
  assert.ok(!content(renderer!.root).includes('LATE'))
  assert.ok(client!.getQueryCache().findAll({queryKey:['pending-scan-groups']}).filter(query=>query.state.data!==undefined).length<=2)
})
it('reports page errors and missing selected records without treating them as an empty queue',async()=>{
  failPage=true;await mount();assert.ok(content(renderer!.root).includes('待确认扫描读取失败'));assert.equal(details.length,0)
  await click('重试');assert.equal(details[0].id,1)
  await act(async()=>details[0].resolve(null));await settle()
  assert.ok(content(renderer!.root).includes('此待确认项已不存在'));assert.ok(content(renderer!.root).includes('120 项待处理'))
})
it('clamps the deleted last page and does not show an old library page',async()=>{
  total=101;await mount(pendingCenterPath({type:'scan',scanOffset:100}))
  assert.equal(details.at(-1)!.id,101)
  total=100;await act(async()=>{await client!.refetchQueries({queryKey:['pending-scan-groups','page'],type:'active'})});await settle();await settle()
  assert.equal(details.at(-1)!.id,51)
  holdOffset=0
  await act(async()=>navigate(pendingCenterPath({type:'scan',libraryId:1})));await settle()
  await act(async()=>navigate(pendingCenterPath({type:'scan',libraryId:2})));await settle();await settle()
  await act(async()=>heldPages[0].resolve(heldPages[0].value));await settle()
  assert.equal(details.at(-1)!.libraryId,2)
  assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).libraryId,2)
})
it('uses only count on another category and count failure does not block that category',async()=>{
  failCount=true;await mount('/pending?type=scrape')
  assert.equal(pages.length,0);assert.equal(details.length,0)
  assert.ok(content(renderer!.root).includes('没有影片刮削待确认项'))
  assert.ok(content(renderer!.root).includes('扫描资源?'))
})

it('does not block scrape on a library listing failure',async()=>{
  failLibraries=true;await mount('/pending?type=scrape')
  assert.ok(content(renderer!.root).includes('没有影片刮削待确认项'))
  assert.ok(!content(renderer!.root).includes('待确认扫描读取失败'))
})
it('resolves identity deep links to the scoped identity pane without group detail reads',async()=>{
  identityMode=true
  await mount(pendingCenterPath({type:'scan',libraryId:2,item:pendingItemKey('scan','identity-4')}))
  assert.deepEqual(pages[0].anchor,{kind:'identity',id:4})
  assert.deepEqual(identityCalls,[2,4]);assert.equal(details.length,0)
  const Pane=(await import('./PendingResourceIdentityPane')).default
  assert.equal(renderer!.root.findAllByType(Pane).length,1)
  assert.equal(renderer!.root.findByType(Pane).props.identity.revision,3)
})
it('retries rejected selected detail without reloading full queues',async()=>{
  await mount()
  await act(async()=>details[0].reject(new Error('detail failure')));await settle()
  assert.ok(content(renderer!.root).includes('扫描详情读取失败'))
  await click('重试');assert.equal(details.length,2);assert.equal(details[1].id,1)
  await act(async()=>details[1].resolve(null));await settle()
  assert.ok(content(renderer!.root).includes('此待确认项已不存在'))
})

it('loads actor details only in its category and keeps inactive summary counts current',async()=>{
  await mount('/pending?type=scan')
  assert.equal(conflictReads,0)
  assert.ok(content(renderer!.root).includes('演员名称冲突17'))
  conflictCount=3
  await act(async()=>{await client!.refetchQueries({queryKey:actressKeys.conflictSummary(),exact:true})});await settle()
  assert.ok(content(renderer!.root).includes('演员名称冲突3'))
  await act(async()=>navigate('/pending?type=actress'));await settle();await settle()
  assert.equal(conflictReads,1)
  await act(async()=>navigate('/pending?type=scan'));await settle();await settle()
  await act(async()=>{await client!.refetchQueries({queryKey:actressKeys.conflicts(),exact:true})});await settle()
  assert.equal(conflictReads,1,'disabled conflict list is not refetched from a scan refresh')
})
it('shows unknown actor count without blocking scan when summary fails',async()=>{
  failConflictCount=true;await mount()
  assert.equal(conflictReads,0)
  assert.ok(content(renderer!.root).includes('演员名称冲突?'))
  assert.ok(content(renderer!.root).includes('120 项待处理'))
})
