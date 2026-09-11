import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { VideoQuery } from '@shared/videoTypes'
import type { ScopedVideoCardPage } from '@shared/cardProjection'

Object.defineProperty(globalThis,'React',{configurable:true,value:React})
const calls:Array<{query:VideoQuery;resolve:(page:ScopedVideoCardPage)=>void;reject:(error:Error)=>void}>=[]
Object.defineProperty(globalThis,'window',{configurable:true,value:{api:{videos:{list:(_scope:unknown,query:VideoQuery)=>new Promise<ScopedVideoCardPage>((resolve,reject)=>calls.push({query,resolve,reject}))}}}})
let renderer:TestRenderer.ReactTestRenderer|undefined,client:QueryClient,navigate:NavigateFunction,url=''
let result!:ReturnType<typeof import('./useCatalogVideoPage').useCatalogVideoPage>
let filter='A'
const onError=()=>{}
async function mount(initial='/director/1'){
  const {useCatalogVideoPage}=await import('./useCatalogVideoPage')
  function Harness(){navigate=useNavigate();const location=useLocation();url=location.pathname+location.search;result=useCatalogVideoPage({kind:'all'}, {search:filter},filter,onError);return null}
  client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:300000}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><Harness/></MemoryRouter></QueryClientProvider>)})
}
afterEach(async()=>{await act(async()=>renderer?.unmount());client?.clear();calls.length=0;filter='A'})
async function answer(index:number,total=125){await act(async()=>calls[index].resolve({items:Array.from({length:Math.min(60,Math.max(0,total-(calls[index].query.offset??0)))},(_,i)=>({id:(calls[index].query.offset??0)+i+1,code:"TEST",title:null,cover_path:null,scraped_status:0,preferredLibraryId:1,membershipAddedAt:"",libraries:[]})),total} as ScopedVideoCardPage));await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})}
it('keeps one related page, preserves URL through nested navigation, resets filters and clamps shrink',async()=>{
  await mount();assert.equal(calls[0].query.limit,60);await answer(0)
  act(()=>result.move(60));assert.match(url,/relatedVideoOffset=60/);await answer(1)
  assert.equal(result.videos[0].id,61)
  await act(async()=>navigate('/director/1/v/61?relatedVideoOffset=60'))
  await act(async()=>navigate(-1));assert.equal(result.offset,60);assert.equal(calls.length,2)
  filter='B';await act(async()=>navigate('/director/1?relatedVideoOffset=60&q=B'))
  assert.equal(calls.at(-1)?.query.offset,0);await answer(calls.length-1)
  assert.doesNotMatch(url,/relatedVideoOffset/)
  filter='C';await act(async()=>navigate('/director/1?q=C'))
  assert.equal(calls.at(-1)?.query.search,'C','filter at page zero must stay enabled');await answer(calls.length-1)
  act(()=>result.move(120));await answer(calls.length-1,10)
  assert.equal(calls.at(-1)?.query.offset,0);await answer(calls.length-1,10)
  assert.equal(result.offset,0);assert.equal(result.videos.length,10)
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})
  assert.ok(client.getQueryCache().getAll().length<=1)
})
it('canonicalizes malformed URL and recovers initial page failure',async()=>{
  await mount('/director/1?relatedVideoOffset=garbage')
  assert.doesNotMatch(url,/relatedVideoOffset/)
  await act(async()=>calls[0].reject(new Error('page failed')))
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,3))})
  assert.ok(result.error);assert.equal(result.loading,false)
  act(()=>result.retry());await answer(1)
  assert.equal(result.videos.length,60)
})
