import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PlaylistListPage, PlaylistListQuery } from '@shared/playlistTypes'
import type { ElectronApi } from '../../../preload/index'

const requests: Array<{query:PlaylistListQuery;resolve:(page:PlaylistListPage)=>void;reject:(error:Error)=>void}>=[]
let full=0
let builtinItems: PlaylistListPage['items'] = []
const api={playlists:{list:async()=>{full++;return []},listPage:(query:PlaylistListQuery)=>query.kind==='builtin'
  ? Promise.resolve({items:builtinItems.filter(item=>item.name.includes(query.search ?? '')),total:builtinItems.length,offset:0,limit:2,hasExactName:false})
  : new Promise<PlaylistListPage>((resolve,reject)=>requests.push({query,resolve,reject}))},playlistImport:{onSnapshotChanged:()=>()=>{}},mediaLibraries:{list:async()=>[]}}
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
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;viewport=continuousViewport();position=0;client?.clear();requests.length=0;full=0;builtinItems=[];delete (api as typeof api & { recentPlayback?: ElectronApi['recentPlayback'] }).recentPlayback})
function text(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('')}
async function resolve(index:number,offset=0,total=125){await act(async()=>requests[index].resolve({offset,total,limit:60,hasExactName:false,items:Array.from({length:Math.min(60,total-offset)},(_,i)=>({id:offset+i+1,name:`List ${offset+i+1}`,description:null,preview_cover_path:null,video_count:0,contains_video:false}))}))}
async function click(label:string){if(label==='下一页'){position+=60;await viewport.scroll(renderer!,position);return}const button=renderer!.root.findAllByType('button').find(node=>text(node)===label)!;assert.ok(button,label);assert.ok(!button.props.disabled);await act(async()=>button.props.onClick())}
function cards(){return renderer!.root.findAllByType('button').filter(node=>node.props['data-playlist-card'])}
it('groups builtins by identity in fixed order and keeps a same-name user list in the paged grid', async () => {
  builtinItems = [
    {id:202,name:'稍后观看',system_kind:'watch_later',description:null,preview_cover_path:null,video_count:3,contains_video:false},
    {id:201,name:'收藏',system_kind:'favorites',description:null,preview_cover_path:null,video_count:1,contains_video:false}
  ]
  Object.assign(api,{recentPlayback:{metadata:async()=>({id:0,name:'最近播放',local_kind:'recently_played',description:'仅此设备',links:[],cover_path:null,preview_cover_path:null,created_at:'',updated_at:null,video_count:0,contains_video:false}),onChanged:()=>()=>{}}})
  await mount()
  await act(async()=>requests[0].resolve({offset:0,total:1,limit:60,hasExactName:false,items:[{id:7,name:'稍后观看',system_kind:null,description:null,preview_cover_path:null,video_count:11,contains_video:false}]}))
  const builtin=renderer!.root.findByProps({'aria-label':'内置清单'})
  assert.deepEqual(builtin.findAllByProps({'data-playlist-card':true}).map(card=>card.props.onClick && text(card).split(/\d/)[0]),['收藏','稍后观看','最近播放'])
  const custom=renderer!.root.findByProps({'aria-label':'我的清单'})
  assert.equal(custom.findAllByProps({'data-playlist-card':true}).length,1)
  assert.match(text(custom),/稍后观看/)
  assert.equal(requests[0].query.kind,'custom')
  assert.match(text(renderer!.root),/共 4 个/)
  await act(async()=>builtin.findAllByProps({'data-playlist-card':true})[0].props.onClick())
  assert.equal(url,'/playlists/201')
})
it('shows a device-only recent card without changing catalog pagination or picker data', async () => {
  Object.assign(api, { recentPlayback: { metadata: async () => ({ id: 0, name: '最近播放', local_kind: 'recently_played',
    description: '仅此设备', links: [], cover_path: null, preview_cover_path: null, created_at: '', updated_at: null,
    video_count: 2, contains_video: false }), onChanged: () => () => {} } })
  await mount(); await resolve(0, 0, 2)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].query.offset, 0)
  const local = cards().find(card => text(card).includes('最近播放'))!
  assert.ok(local)
  assert.match(text(renderer!.root), /共 3 个/)
  await act(async () => local.props.onClick())
  assert.equal(url, '/playlists/0')
  assert.equal(full, 0)
})
it('keeps a pending search draft when the grid reports the unchanged URL page', async () => {
  await mount(); await resolve(0)
  await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'draft' } }))
  await viewport.scroll(renderer!, 0)
  assert.equal(renderer!.root.findByType('input').props.value, 'draft')
  await act(async () => { await new Promise(done => setTimeout(done, 330)) })
  assert.match(url, /q=draft/)
})
it('keeps a pending search draft when scrolling reaches another page before debounce', async () => {
  await mount(); await resolve(0)
  await act(async () => renderer!.root.findByType('input').props.onChange({ target: { value: 'draft' } }))
  await viewport.scroll(renderer!, 60)
  assert.equal(renderer!.root.findByType('input').props.value, 'draft')
  await act(async () => { await new Promise(done => setTimeout(done, 330)) })
  assert.match(url, /q=draft/)
  assert.doesNotMatch(url, /playlistOffset/)
})
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

it('actual import provider reads paged custom options only when its append picker opens',async()=>{
  await mount();await resolve(0)
  await click('导入外部清单')
  assert.equal(full,0);assert.equal(requests.length,1)
  const Select=(await import('../components/SelectControl')).default
  const destination=renderer!.root.findAllByType(Select).find(node=>node.props.value==='create')!
  assert.ok(destination)
  await act(async()=>destination.props.onChange({target:{value:'append'}}))
  assert.equal(requests.length,1,'switching to append mode does not read a closed picker')
  const Picker=(await import('../components/PlaylistDestinationPicker')).default
  assert.equal(renderer!.root.findAllByType(Picker).length,1)
  await click('选择目标清单')
  assert.equal(full,0);assert.equal(requests.length,2);assert.equal(requests[1].query.limit,60)
  assert.equal(requests[1].query.kind,'custom')
  await resolve(1)
  const pickerRows=()=>renderer!.root.findByType(Picker).findAllByProps({role:'option'})
  assert.ok(pickerRows().length>0 && pickerRows().length<60,'candidate DOM remains smaller than the server page')
  await act(async()=>pickerRows()[0].props.onClick())
  assert.equal(renderer!.root.findByType(Picker).props.value,'1')
  assert.equal(renderer!.root.findByType(Picker).props.label,'List 1')
  assert.equal(pickerRows().length,0,'selection closes candidates without losing the provider draft')
})
