import assert from 'node:assert/strict'
import { afterEach, it, type TestContext } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ActressGalleryPage, ActressGalleryPageQuery } from '@shared/actressTypes'
import type { ElectronApi } from '../../../preload/index'
import type { ImagePreviewLightboxProps } from './ImagePreviewLightbox'

const calls: ActressGalleryPageQuery[] = []
let entries = Array.from({length:125}, (_,n) => n+1)
let hold: ((query: ActressGalleryPageQuery) => Promise<ActressGalleryPage>) | null = null
let fail = false
let historyCount = 0
function page(query: ActressGalleryPageQuery): ActressGalleryPage {
  const position = query.anchorId === undefined ? -1 : entries.indexOf(query.anchorId)
  const offset = position >= 0 ? Math.floor(position/60)*60 : query.offset ?? 0
  return { items: entries.slice(offset,offset+60).map(id => ({id, actress_id:1, type:'photo' as const, local_path:`photos/${id}.jpg`,remote_url:null,position:id,width:400,height:600,created_at:null})), offset,limit:60,total:entries.length,
    ...(query.anchorId === undefined ? {} : {anchorIndex:position < 0 ? null : position-offset}) }
}
const fake = { actresses: {
  deleteGalleryImage: async (_actor: number, id: number) => { entries=entries.filter(value=>value!==id); return true },
  importGalleryImage: async () => { entries.push(200); return true },
  setPoster: async () => true,
  galleryPage: async (_id: number, query: ActressGalleryPageQuery) => {
  calls.push(query)
  if (fail) { fail=false; throw Error('Photo page failed') }
  if (hold) { const run=hold; hold=null; return run(query) }
  return page(query)
} } } as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{
  api:fake,location:{href:'http://localhost/'},setTimeout,clearTimeout,
  history:{state:null,pushState(){historyCount++},back(){window.dispatchEvent(new Event('popstate'))}}
})})
Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{style:{overflow:''}},activeElement:null}})
let renderer: TestRenderer.ReactTestRenderer | undefined
let Component: typeof import('./ActressGalleryPanel').default
let Provider: typeof import('./ImagePreviewOverlayContext').ImagePreviewOverlayProvider
let revision = {}
function tree() { return <Provider><Component key={1} actressId={1} revision={revision} posterPath={null} onChanged={()=>{ revision={}; renderer?.update(tree()) }} /></Provider> }
async function mount(t: TestContext) {
  Component=(await import('./ActressGalleryPanel')).default
  Provider=(await import('./ImagePreviewOverlayContext')).ImagePreviewOverlayProvider
  const Lightbox=(await import('./ImagePreviewLightbox')).default
  const create=React.createElement
  t.mock.method(React,'createElement',(type: unknown, props: unknown,...children:unknown[])=> type===Lightbox ? create('div',{'data-lightbox':props}) : Reflect.apply(create,React,[type,props,...children]))
  await act(async()=>{renderer=TestRenderer.create(tree())})
}
function preview() { return renderer!.root.findAllByType('div').find(n=>n.props['data-lightbox'])?.props['data-lightbox'] as ImagePreviewLightboxProps | undefined }
const tiles=()=>renderer!.root.findAllByType('button').filter(n=>/^写真 \d+$/.test(n.props['aria-label']??''))
async function click(label:string) { await act(async()=>{const n=renderer!.root.findAllByType('button').find(n=>n.props['aria-label']===label || n.children.join('')===label)!;assert.ok(n,label);assert.ok(!n.props.disabled);n.props.onClick({stopPropagation(){},preventDefault(){},currentTarget:{blur(){}}})}) }
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;calls.length=0;entries=Array.from({length:125},(_,n)=>n+1);hold=null;fail=false;historyCount=0;revision={}})

it('bounds grid and preview windows, crosses both page edges and preserves one history entry', async t=>{
  await mount(t)
  assert.equal(tiles().length,60)
  await click('下一页');assert.equal(tiles()[0].props['aria-label'],'写真 61')
  await click('下一页');assert.equal(tiles().length,5)
  await click('写真 121')
  assert.equal(preview()!.total,125);assert.equal(preview()!.windowOffset,120)
  await act(async()=>preview()!.onIndexChange(-1))
  assert.equal(preview()!.windowOffset,60);assert.equal(preview()!.index,59)
  assert.equal(preview()!.items[59].id,120)
  await act(async()=>preview()!.onIndexChange(60))
  assert.equal(preview()!.windowOffset,120);assert.equal(preview()!.index,0)
  assert.equal(preview()!.items[0].thumbnailSrc,'media://photos/121.jpg?size=320')
  assert.equal(preview()!.items[0].src,'media://photos/121.jpg')
  assert.equal(tiles().length,5)
  assert.equal(historyCount,1)
})

it('retains the current photo on page failure, retries, and discards a response after close',async t=>{
  await mount(t);await click('写真 60');fail=true
  await act(async()=>preview()!.onIndexChange(60))
  assert.equal(preview()!.items[preview()!.index].id,60)
  assert.ok(preview()!.navigationStatus)
  const action=preview()!.navigationStatus as React.ReactElement
  const retry=React.Children.toArray(action.props.children).find(v=>React.isValidElement(v)) as React.ReactElement
  await act(async()=>retry.props.onClick())
  assert.equal(preview()!.items[preview()!.index].id,61)
  let finish!: (value:ActressGalleryPage)=>void
  hold=()=>new Promise(resolve=>{finish=resolve})
  await act(async()=>preview()!.onIndexChange(-1))
  assert.equal(preview()!.loading,true)
  await act(async()=>preview()!.onClose())
  await act(async()=>finish(page({offset:0})))
  assert.equal(preview(),undefined)
})

it('refreshes by stable ID after reorder and closes a removed preview without selecting its replacement',async t=>{
  await mount(t);await click('写真 60')
  entries=[60,...entries.filter(id=>id!==60)]
  revision={};await act(async()=>renderer!.update(tree()))
  assert.equal(preview()!.items[preview()!.index].id,60)
  assert.equal(preview()!.index,0)
  assert.ok(calls.some(q=>q.anchorId===60))
  entries=entries.filter(id=>id!==60)
  revision={};await act(async()=>renderer!.update(tree()))
  assert.equal(preview(),undefined)
})


it('deletes the last photo on a page and refreshes imported photos through the actual panel callbacks',async t=>{
  entries=entries.slice(0,121)
  await mount(t)
  await click('下一页');await click('下一页')
  assert.equal(tiles().length,1)
  await click('删除写真 121');await click('删除')
  assert.equal(entries.length,120)
  assert.equal(tiles().length,60)
  assert.equal(tiles()[0].props['aria-label'],'写真 61')
  await click('导入写真')
  const Import=(await import('./ImageImportModal')).default
  const importer=renderer!.root.findByType(Import)
  await act(async()=>{await importer.props.onImportUrl('https://example.test/new.jpg');importer.props.onChanged()})
  await act(async()=>importer.props.onCancel())
  await click('下一页')
  assert.equal(tiles().length,1)
  await click('写真 121')
  assert.equal(preview()!.items[0].id,200)
  await act(async()=>{await preview()!.onPosterChange!('photos/200.jpg')})
  assert.equal(preview()!.items[preview()!.index].id,200)
})
