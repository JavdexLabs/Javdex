import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlaylistListPage, PlaylistListQuery } from '@shared/playlistTypes'

const requests: Array<{query:PlaylistListQuery;resolve:(page:PlaylistListPage)=>void;reject:(error:Error)=>void}>=[]
let full=0
const api={playlists:{list:async()=>{full++;return []},listPage:(query:PlaylistListQuery)=>new Promise<PlaylistListPage>((resolve,reject)=>requests.push({query,resolve,reject}))},playlistImport:{onSnapshotChanged:()=>()=>{}},mediaLibraries:{list:async()=>[]}}
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api,setTimeout,clearTimeout,requestAnimationFrame:(fn:()=>void)=>fn()})})
Object.defineProperty(globalThis,'document',{configurable:true,value:Object.assign(new EventTarget(),{body:{style:{overflow:''}},activeElement:null})})
let viewport=continuousViewport(),position=0
let renderer:TestRenderer.ReactTestRenderer|undefined,client:QueryClient,navigate:NavigateFunction,url=''
function Location(){navigate=useNavigate();const location=useLocation();url=location.pathname+location.search;return null}
async function mount(initial='/playlists'){
  const Shell=(await import('../components/PlaylistShell')).default
  const Provider=(await import('../components/playlistImport/PlaylistImportContext')).PlaylistImportProvider
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><Provider><Location/><Routes><Route path="/playlists" element={<Shell/>}><Route path=":playlistId" element={<div>Detail</div>}/></Route></Routes></Provider></MemoryRouter></QueryClientProvider>,{createNodeMock:viewport.createNodeMock})})
}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;viewport=continuousViewport();position=0;client?.clear();requests.length=0;full=0})
function text(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('')}
async function resolve(index:number,offset=0,total=125){await act(async()=>requests[index].resolve({offset,total,limit:60,hasExactName:false,items:Array.from({length:Math.min(60,total-offset)},(_,i)=>({id:offset+i+1,name:`List ${offset+i+1}`,description:null,preview_cover_path:null,video_count:0,contains_video:false}))}))}
async function click(label:string){if(label==='下一页'){position+=60;await viewport.scroll(renderer!,position);return}const button=renderer!.root.findAllByType('button').find(node=>text(node)===label)!;assert.ok(button,label);assert.ok(!button.props.disabled);await act(async()=>button.props.onClick())}
function cards(){return renderer!.root.findAllByType('button').filter(node=>String(node.props.className).startsWith('playlist-card '))}
it('pages 60/60/5 in URL and restores the same page after nested detail without full reads',async()=>{
  await mount();assert.equal(full,0);await resolve(0);assert.ok(cards().length > 0 && cards().length <= 8)
  await click('下一页');assert.match(url,/playlistOffset=60/);await resolve(1,60)
  await act(async()=>cards().find(card=>text(card).includes('List 61'))!.props.onClick());assert.match(url,/playlists\/61\?playlistOffset=60/)
  assert.equal(requests.length,2)
  assert.ok(cards().some(card=>text(card).includes('List 61')),'list window stays mounted under detail')
  await act(async()=>navigate(-1))
  assert.ok(requests.length>=3)
  assert.ok(cards().some(card=>text(card).includes('List 61')),'retained rows remain while silent refetch runs')
  for(let index=2;index<requests.length;index++) await resolve(index,requests[index].query.offset ?? 0)
  await click('下一页')
  // Overscan may request the preceding retained boundary before the last page.
  for(let index=3;index<requests.length;index++) await resolve(index,requests[index].query.offset ?? 0)
  assert.ok(cards().some(card=>text(card).includes('List 125')));assert.ok(cards().length <= 8)
})
it('does not resurrect a draft when detail navigation interrupts debounce',async()=>{
  await mount();await resolve(0)
  await click('下一页')
  await act(async()=>renderer!.root.findByType('input').props.onChange({target:{value:'draft'}}))
  await act(async()=>navigate('/playlists/9?playlistOffset=60'))
  await act(async()=>navigate(-1))
  await act(async()=>{await new Promise(done=>setTimeout(done,330))})
  assert.doesNotMatch(url,/q=/);assert.equal(renderer!.root.findByType('input').props.value,'')
  await resolve(1,60);assert.ok(cards().length > 0 && cards().length <= 8)
})

it('retries a failed first playlist page',async()=>{
  await mount()
  await act(async()=>requests[0].reject(new Error('page failed')))
  assert.match(text(renderer!.root),/播放清单加载失败/)
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,0)
  await click('重试');await resolve(requests.length-1)
  assert.ok(cards().length > 0 && cards().length <= 8)
})

it('keeps the playlist grid and retry when a later page fails',async()=>{
  await mount();await resolve(0)
  await click('下一页')
  await act(async()=>requests[1].reject(new Error('later failed')))
  const Grid=(await import('../components/ContinuousGrid')).default
  assert.equal(renderer!.root.findAllByType(Grid).length,1)
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,1)
  assert.match(text(renderer!.root),/later failed/)
  await click('重试')
  for (let index = 2; index < requests.length; index++) await resolve(index, requests[index].query.offset ?? 0)
  assert.ok(cards().some(card=>text(card).includes('List 61')))
})

it('actual import provider defers playlist options until append mode and keeps them paged',async()=>{
  await mount();await resolve(0)
  await click('导入外部清单')
  assert.equal(full,0);assert.equal(requests.length,1)
  const Select=(await import('../components/SelectControl')).default
  const destination=renderer!.root.findAllByType(Select).find(node=>node.props.value==='create')!
  assert.ok(destination)
  await act(async()=>destination.props.onChange({target:{value:'append'}}))
  assert.equal(full,0);assert.equal(requests.length,2);assert.equal(requests[1].query.limit,60)
  await resolve(1)
  const Picker=(await import('../components/PlaylistDestinationPicker')).default
  assert.equal(renderer!.root.findAllByType(Picker).length,1)
})
