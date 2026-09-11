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
let renderer:TestRenderer.ReactTestRenderer|undefined,client:QueryClient,navigate:NavigateFunction,url=''
function Location(){navigate=useNavigate();const location=useLocation();url=location.pathname+location.search;return null}
async function mount(initial='/playlists'){
  const Shell=(await import('../components/PlaylistShell')).default
  const Provider=(await import('../components/playlistImport/PlaylistImportContext')).PlaylistImportProvider
  client=new QueryClient({defaultOptions:{queries:{retry:false}}})
  await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><Provider><Location/><Routes><Route path="/playlists" element={<Shell/>}><Route path=":playlistId" element={<div>Detail</div>}/></Route></Routes></Provider></MemoryRouter></QueryClientProvider>)})
}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;client?.clear();requests.length=0;full=0})
function text(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('')}
async function resolve(index:number,offset=0,total=125){await act(async()=>requests[index].resolve({offset,total,limit:60,hasExactName:false,items:Array.from({length:Math.min(60,total-offset)},(_,i)=>({id:offset+i+1,name:`List ${offset+i+1}`,description:null,preview_cover_path:null,video_count:0,contains_video:false}))}))}
async function click(label:string){const button=renderer!.root.findAllByType('button').find(node=>text(node)===label)!;assert.ok(button,label);assert.ok(!button.props.disabled);await act(async()=>button.props.onClick())}
function cards(){return renderer!.root.findAllByType('button').filter(node=>String(node.props.className).startsWith('playlist-card '))}
it('pages 60/60/5 in URL and restores the same page after nested detail without full reads',async()=>{
  await mount();assert.equal(full,0);await resolve(0);assert.equal(cards().length,60)
  await click('下一页');assert.match(url,/playlistOffset=60/);await resolve(1,60)
  await act(async()=>cards()[0].props.onClick());assert.match(url,/playlists\/61\?playlistOffset=60/)
  assert.equal(requests.length,2)
  await act(async()=>navigate(-1));assert.equal(requests.length,3);assert.equal(requests[2].query.offset,60)
  await resolve(2,60);await click('下一页');await resolve(3,120);assert.equal(cards().length,5)
})
it('does not resurrect a draft when detail navigation interrupts debounce; ignores old pages and retries errors',async()=>{
  await mount();await resolve(0)
  await click('下一页')
  await act(async()=>renderer!.root.findByType('input').props.onChange({target:{value:'draft'}}))
  await act(async()=>navigate('/playlists/9?playlistOffset=60'))
  await act(async()=>navigate(-1))
  await act(async()=>{await new Promise(done=>setTimeout(done,330))})
  assert.doesNotMatch(url,/q=/);assert.equal(renderer!.root.findByType('input').props.value,'')
  await resolve(1,60);assert.equal(cards().length,0)
  const last=requests.length-1
  await act(async()=>requests[last].reject(new Error('page failed')))
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,1)
  await click('重试');await resolve(requests.length-1,60);assert.equal(cards().length,60)
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
