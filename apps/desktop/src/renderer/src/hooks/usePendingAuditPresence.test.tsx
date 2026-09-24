import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
function deferred() {
  let resolve!: (value:number[])=>void, reject!: (error:Error)=>void
  const promise=new Promise<number[]>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}
const requests:Array<{ids:number[]} & ReturnType<typeof deferred>>=[]
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:{api:{scan:{pendingAuditPresence:(_libraryId:number,input:{scrapeIds:number[]})=>{
  const ids=input.scrapeIds;
  const request={ids,...deferred()};requests.push(request);return request.promise.then(scrapeIds=>({groupIds:[],identityIds:[],scrapeIds}))
}}}}})
let renderer:TestRenderer.ReactTestRenderer | undefined
let current:ReturnType<typeof import('./usePendingAuditPresence').usePendingAuditPresence>
let hook:typeof import('./usePendingAuditPresence').usePendingAuditPresence
function Probe({ids,scope}:{ids:number[];scope:string}):null {current=hook(1,{groupIds:[],identityIds:[],scrapeIds:ids},scope);return null}
async function show(ids:number[],scope='one') {
  hook=(await import('./usePendingAuditPresence')).usePendingAuditPresence
  await act(async()=>{
    if(renderer)renderer.update(<Probe ids={ids} scope={scope}/> )
    else renderer=TestRenderer.create(<Probe ids={ids} scope={scope}/> )
  })
}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;requests.length=0})
it('sends no empty lookup, deduplicates IDs and rejects a stale page response',async()=>{
  await show([]);assert.equal(requests.length,0);assert.equal(current.state,'ready')
  await show([3,1,3]);assert.deepEqual(requests[0].ids,[1,3]);assert.equal(current.state,'loading')
  await show([2]);assert.equal(current.ids.size,0)
  await act(async()=>requests[1].resolve([2]));assert.equal(current.state,'ready');assert.deepEqual([...current.ids],['scrape:2'])
  await act(async()=>requests[0].resolve([1,3]));assert.deepEqual([...current.ids],['scrape:2'])
})
it('distinguishes a failed lookup from processed items and retries the same page',async()=>{
  await show([1])
  await act(async()=>requests[0].reject(new Error('injected')))
  assert.equal(current.state,'error')
  await act(async()=>current.retry());assert.equal(current.state,'loading')
  await act(async()=>requests[1].resolve([]));assert.equal(current.state,'ready');assert.equal(current.ids.size,0)
  await show([1],'next-run');assert.equal(current.state,'loading');assert.equal(requests.length,3)
})


it('does not reuse old ready state when a page is revisited before another lookup finishes',async()=>{
  await show([1]);await act(async()=>requests[0].resolve([1]));assert.equal(current.state,'ready')
  await show([2]);await show([1])
  assert.equal(current.state,'loading');assert.equal(current.ids.size,0)
  await act(async()=>requests[1].resolve([2]));assert.equal(current.state,'loading')
  await act(async()=>requests[2].resolve([]));assert.equal(current.state,'ready');assert.equal(current.ids.size,0)
})
