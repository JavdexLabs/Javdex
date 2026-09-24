import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ElectronApi } from '../../../preload/index'
import type { PendingVideoScrape, PendingVideoScrapePage, PendingVideoScrapePageQuery } from '@shared/videoScrapeTypes'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const pages: PendingVideoScrapePageQuery[] = []
const details: Array<{id:number} & ReturnType<typeof deferred<PendingVideoScrape | null>>> = []
let failPage = false
let location = ''
let navigate: NavigateFunction
let holdOffset: number | undefined
const heldPages: Array<{value:PendingVideoScrapePage} & ReturnType<typeof deferred<PendingVideoScrapePage>>> = []
let total = 120
let failCount = false
const fakeApi = {
  mediaLibraries: { list: async () => [] },
  actressScrape: { listConflicts: () => { throw new Error('Full actress queue is forbidden') }, pageConflicts: async () => ({items:[],total:0,offset:0}), conflictSummary: async () => ({ groupCount: 0 }) },
  scan: { countPendingQueue: async () => 0, pagePendingQueue: async () => ({items: [], total: 0, offset: 0}) },
  scrape: {
    listPending: () => { throw new Error('Full inbox must never be requested') },
    countPending: async () => { if(failCount)throw new Error('count failure');return total },
    pagePending: async (query: PendingVideoScrapePageQuery) => {
      pages.push(query)
      if (failPage) { failPage = false; throw new Error('injected page failure') }
      const anchor = query.videoId ?? query.anchorId
      const offset = anchor && anchor <= total ? Math.floor((anchor - 1) / 50) * 50 : Math.min(query.offset ?? 0, Math.max(0, Math.floor((total-1)/50)*50))
      const value = { total, offset, items: Array.from({length:Math.min(50,total-offset)},(_,i)=>({
        id:offset+i+1,videoId:offset+i+1,revision:1,code:`CODE-${offset+i+1}`,
        candidateCount:2,sourceCount:1,stagedCoverPath:null
      })) }
      if(holdOffset === offset) { holdOffset=undefined; const held={value,...deferred<PendingVideoScrapePage>()};heldPages.push(held);return held.promise }
      return value
    },
    getPending: (id:number) => { const request={id,...deferred<PendingVideoScrape | null>()}; details.push(request); return request.promise }
  },
  videos: { get: async () => null }
} as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:fakeApi})})
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient | undefined
function LocationProbe(): null { navigate=useNavigate(); const current=useLocation(); location=current.search; return null }
async function settle(): Promise<void> {
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))})
}
async function mount(url='/pending?type=scrape'): Promise<void> {
  const Page=(await import('./PendingCenterPage')).default
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client!}>
    <MemoryRouter initialEntries={[url]}><LocationProbe/><Page/></MemoryRouter>
  </QueryClientProvider>)})
  await settle(); await settle()
}
function content(node:TestRenderer.ReactTestInstance):string {
  return node.children.map(child=>typeof child==='string'?child:content(child)).join('')
}
async function click(label:string):Promise<void> {
  const button=renderer!.root.findAllByType('button').find(node=>content(node)===label)
  assert.ok(button,label);assert.ok(!button.props.disabled)
  await act(async()=>{button.props.onClick()});await settle();await settle()
}
afterEach(async()=>{
  await act(async()=>{renderer?.unmount()});client?.clear();renderer=undefined;client=undefined
  pages.length=0;details.length=0;failPage=false;failCount=false;total=120;holdOffset=undefined;heldPages.length=0
})

it('locates a deep-linked pending item, pages with a bounded cache and ignores a late detail',async()=>{
  await mount('/pending?type=scrape&videoId=110')
  assert.equal(pages[0].videoId,110)
  assert.ok(location.includes('scrape%3A110'))
  assert.ok(location.includes('scrapeOffset=100'))
  assert.deepEqual(details.map(entry=>entry.id),[110])
  assert.equal(renderer!.root.findAllByType('button').filter(node=>node.props['aria-current'] !== undefined).length,20)
  await click('上一页')
  assert.equal(details.at(-1)!.id,51)
  await act(async()=>{details[0].resolve({id:110,videoId:110,revision:1,sources:[],warnings:[],selectedFields:[],applicableFields:[],updateMode:'replace',createdAt:'2026',updatedAt:'2026',stagedBytes:0})})
  await settle()
  const Pane=(await import('./PendingScrapePane')).default
  assert.equal(renderer!.root.findAllByType(Pane).length,0,'old detail cannot appear on new selection')
  await act(async()=>{details.at(-1)!.resolve(null)});await settle()
  assert.ok(content(renderer!.root).includes('此待确认项已不存在'))
  assert.ok(client!.getQueryCache().findAll({queryKey:['pending-video-scrapes']}).length<=2,'only current summary and selected detail remain')
})

it('shows an explicit page error and retries without fetching the full inbox',async()=>{
  failPage=true
  await mount()
  assert.ok(content(renderer!.root).includes('待确认刮削读取失败'))
  assert.equal(details.length,0)
  await click('重试')
  assert.equal(details.at(-1)!.id,1)
  assert.ok(content(renderer!.root).includes('120 项待处理'))
})


it('recovers the last page after deletion and selects the surviving first item',async()=>{
  total=101
  await mount('/pending?type=scrape&item=scrape%3A101&scrapeOffset=100')
  assert.equal(details.at(-1)!.id,101)
  await act(async()=>{details.at(-1)!.resolve(null)});await settle()
  total=100
  await click('刷新队列')
  assert.ok(location.includes('scrape%3A51'))
  assert.ok(location.includes('scrapeOffset=50'))
  assert.equal(details.at(-1)!.id,51)
})

it('does not block a different queue when scrape count fails or reuse its disabled page total',async()=>{
  await mount('/pending')
  const calls=pages.length
  total=7
  await act(async()=>{navigate('/pending?type=scan&item=scrape%3A1')});await settle();await settle()
  assert.ok(content(renderer!.root).includes('没有扫描资源待确认项'))
  assert.equal(pages.length,calls)
  const badge=renderer!.root.findAllByType('em').find(node=>content(node)==='7')
  assert.ok(badge,'disabled page total must not override refreshed count')
  failCount=true
  await act(async()=>{await client!.invalidateQueries({queryKey:['pending-video-scrape-count']})});await settle()
  assert.ok(content(renderer!.root).includes('没有扫描资源待确认项'))
  assert.ok(!content(renderer!.root).includes('待确认刮削读取失败'))
})


it('ignores an old page that resolves after navigation to a newer page',async()=>{
  await mount()
  holdOffset=50
  await act(async()=>{navigate('/pending?type=scrape&scrapeOffset=50')});await settle()
  assert.equal(heldPages.length,1)
  await act(async()=>{navigate('/pending?type=scrape&scrapeOffset=100')});await settle();await settle()
  assert.equal(details.at(-1)!.id,101)
  await act(async()=>{heldPages[0].resolve(heldPages[0].value)});await settle()
  assert.ok(location.includes('scrape%3A101'))
  assert.equal(details.at(-1)!.id,101)
  assert.ok(content(renderer!.root).includes('CODE-101'))
  assert.ok(!content(renderer!.root).includes('CODE-51'))
})
