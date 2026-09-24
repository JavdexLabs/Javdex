import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useWindowedCatalog } from './useWindowedCatalog'
import { refetchStaleLibraryQueries } from './invalidateLibraryQueries'
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient
async function settle(check: () => boolean) {
  for (let i=0;i<80;i++) { if(check()) return; await act(async()=>{await new Promise(resolve=>setTimeout(resolve,2))}) }
  assert.fail('window did not settle')
}
afterEach(async()=>{await act(async()=>renderer?.unmount());client?.clear()})

it('holds three pages across 100 forward/backward positions and twenty filters, retaining absolute IDs', async()=>{
  const calls: Array<{filter:string;offset:number}>=[]
  let result!: ReturnType<typeof useWindowedCatalog<{id:number}, {items:{id:number}[];total:number}>>
  function Harness({filter}:{filter:string}) {
    result=useWindowedCatalog(['videos','window-budget',filter],200,async offset=>{
      calls.push({filter,offset});return {items:Array.from({length:200},(_,i)=>({id:offset+i+1})),total:24000}
    });return null
  }
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  const render=(filter:string)=><QueryClientProvider client={client}><Harness filter={filter}/></QueryClientProvider>
  await act(async()=>{renderer=TestRenderer.create(render('first'))})
  await settle(()=>result.window.getItem(0)?.id===1)
  for(let page=1;page<100;page++) {
    act(()=>result.window.onVisibleRange(page*200,page*200+30))
    await settle(()=>result.window.getItem(page*200)?.id===page*200+1)
    assert.ok(result.items.length<=600)
  }
  assert.equal(result.window.getItem(0),undefined)
  act(()=>result.window.onVisibleRange(0,30))
  await settle(()=>result.window.getItem(0)?.id===1)
  assert.ok(calls.filter(c=>c.offset===0).length>=2)
  for(let filter=0;filter<20;filter++) {
    await act(async()=>renderer!.update(render(`filter-${filter}`)))
    await settle(()=>result.window.getItem(0)?.id===1 && !result.isFetching)
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,2))})
    assert.ok(client.getQueryCache().getAll().length<=3)
  }
  const before=calls.length
  act(()=>result.refetchSilent())
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})
  assert.equal(calls.length,before,'read-only return must not refresh fresh pages')
  client.setQueryData(['videos','inactive-history'],{items:[]})
  refetchStaleLibraryQueries(client)
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})
  assert.equal(calls.length,before)
})

it('preserves geometry on page failure and clamps after shrink; late filter data cannot land',async()=>{
  let fail=false,total=1000,filter='A'
  const deferred: Array<(page:{items:{id:number}[];total:number})=>void>=[]
  let result!: ReturnType<typeof useWindowedCatalog<{id:number},{items:{id:number}[];total:number}>>
  function Harness() { result=useWindowedCatalog(['videos','window-races',filter],200,async offset=>{
    if(filter==='slow')return await new Promise(resolve=>deferred.push(resolve))
    if(fail && offset===800)throw new Error('page failure')
    return {items:Array.from({length:Math.min(200,Math.max(0,total-offset))},(_,i)=>({id:offset+i+1})),total}
  });return null }
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  const render=()=> <QueryClientProvider client={client}><Harness/></QueryClientProvider>
  await act(async()=>{renderer=TestRenderer.create(render())});await settle(()=>result.items.length===200)
  fail=true;act(()=>result.window.onVisibleRange(800,820));await settle(()=>result.window.error)
  assert.equal(result.total,1000);assert.equal(result.loading,false);assert.equal(result.window.getItem(800),undefined)
  fail=false;act(()=>result.retry());await settle(()=>result.window.getItem(800)?.id===801)
  total=10;act(()=>result.retry());await settle(()=>result.total===10 && result.window.getItem(0)?.id===1)
  filter='slow';await act(async()=>renderer!.update(render()));await settle(()=>deferred.length>0)
  filter='new';await act(async()=>renderer!.update(render()));await settle(()=>result.total===10)
  await act(async()=>{for(const resolve of deferred)resolve({items:[{id:9999}],total:1})})
  assert.equal(result.total,10);assert.equal(result.window.getItem(0)?.id,1)
})

it('reads half-open selection ranges as identities, rejects changed snapshots, and stops canceled reads',async()=>{
  type Row={id:number;description:string}
  type Page={items:Row[];total:number;readRevision:string}
  let result!: ReturnType<typeof useWindowedCatalog<Row,Page>>
  let revision='first',reads=0,changeAfterRead=false
  let hold: (()=>void)|undefined
  function Harness() { result=useWindowedCatalog(['videos','selection-snapshot'],200,async offset=>{
    reads++
    const captured=revision
    if(hold) await new Promise<void>(resolve=>{hold=resolve})
    const page={items:Array.from({length:200},(_,i)=>({id:offset+i+1,description:'wide'.repeat(100)})),total:24000,readRevision:captured}
    if(changeAfterRead)revision='changed'
    return page
  });return null }
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><Harness/></QueryClientProvider>)})
  await settle(()=>result.total===24000)
  const range=await result.window.readRange(199,402)
  assert.equal(range.length,203);assert.deepEqual(range[0],{id:200});assert.deepEqual(range.at(-1),{id:402})
  assert.equal(result.items.length,200,'selection reads do not populate browsing history')
  changeAfterRead=true
  await assert.rejects(result.window.readRange(199,402),/列表已变化/)
  changeAfterRead=false
  const controller=new AbortController()
  hold=()=>{}
  const before=reads
  const pending=result.window.readRange(0,10000,controller.signal)
  controller.abort();hold();hold=undefined
  await assert.rejects(pending,/取消/)
  assert.equal(reads,before+1,'cancellation stops before the next IPC page')
})

it('restores an evicted page anchor after remount while retaining no inactive card pages',async()=>{
  let result!:ReturnType<typeof useWindowedCatalog<{id:number},{items:{id:number}[];total:number}>>
  const calls:number[]=[]
  function Harness(){result=useWindowedCatalog(['videos','remount-anchor'],200,async offset=>{calls.push(offset);return {items:Array.from({length:200},(_,i)=>({id:offset+i+1})),total:24000}});return null}
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  const render=()=> <QueryClientProvider client={client}><Harness/></QueryClientProvider>
  await act(async()=>{renderer=TestRenderer.create(render())});await settle(()=>result.total===24000)
  act(()=>result.window.onVisibleRange(19800,19830));await settle(()=>result.window.getItem(19800)?.id===19801)
  await act(async()=>renderer!.unmount())
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})
  assert.equal(client.getQueryCache().getAll().length,0)
  await act(async()=>{renderer=TestRenderer.create(render())})
  await settle(()=>result.window.getItem(19800)?.id===19801)
  assert.equal(calls.at(-1),19800)
  assert.equal(result.items.length,200)
})
