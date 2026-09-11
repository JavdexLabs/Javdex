import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

const requests: Array<{ query: Record<string, unknown>; resolve: (page: unknown) => void; reject: (error: Error) => void }> = []
let fullCalls = 0
const added: Array<[number, number]> = []
const created: string[] = []
const fakeApi = { playlists: {
  list: async () => { fullCalls++; return [] },
  listForVideo: async () => { fullCalls++; return [] },
  listPage: (query: Record<string, unknown>) => new Promise((resolve, reject) => requests.push({ query, resolve, reject })),
  addVideo: async (id: number, video: number) => { added.push([id, video]); return true },
  removeVideo: async () => true,
  create: async (input: {name: string}) => { created.push(input.name); return 999 }
} }
Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { api: fakeApi, setTimeout, clearTimeout }) })
Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { body: { style: { overflow: '' } }, activeElement: null }) })
let Picker: typeof import('./AddVideosToPlaylistModal')['default']
let viewport=continuousViewport()
let renderer: TestRenderer.ReactTestRenderer | undefined
before(async () => { Picker = (await import('./AddVideosToPlaylistModal')).default })
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined;viewport=continuousViewport(); requests.length = 0; fullCalls = 0; added.length = 0; created.length = 0 })
function text(node: TestRenderer.ReactTestInstance): string { return node.children.map(child => typeof child === 'string' ? child : text(child)).join('') }
async function click(label: string) {
  if(label==='下一页'){await viewport.scroll(renderer!,60);return}
  const button = renderer!.root.findAllByType('button').find(node => text(node) === label)!
  assert.ok(button, label); assert.ok(!button.props.disabled, label)
  await act(async () => { button.props.onClick() })
}
async function resolve(index: number, offset = 0, total = 125, exact = false) {
  await act(async () => requests[index].resolve({ offset, limit: 60, total, hasExactName: exact,
    items: Array.from({ length: Math.min(60, total - offset) }, (_, i) => ({ id: offset + i + 1, name: `List ${offset+i+1}`, description: null, preview_cover_path: null, video_count: 0, contains_video: false })) }))
}
it('loads only a server page and replaces sixty rows when advancing', async () => {
  await act(async () => { renderer = TestRenderer.create(<Picker videoIds={[7, 2]} onCancel={() => {}} />, {createNodeMock:viewport.createNodeMock}) })
  assert.equal(fullCalls, 0)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].query.limit, 60)
  await resolve(0)
  assert.ok(renderer!.root.findAll(node => node.props.className === 'playlist-pick-row').length <= 8)
  await click('下一页'); await resolve(1, 60)
  assert.ok(renderer!.root.findAll(node => node.props.className === 'playlist-pick-row').length <= 8)
  const row=renderer!.root.findAll(node=>node.props.className==='playlist-pick-row')
    .find(node=>text(node).includes('List 61'))!
  await act(async()=>row.findAllByType('button').find(node=>text(node)==='加入')!.props.onClick())
  assert.deepEqual(added, [[61, 7], [61, 2]])
})

it('does not create from a stale page or an off-page exact match, and retains full create input', async () => {
  await act(async () => { renderer=TestRenderer.create(<Picker videoIds={[7]} onCancel={()=>{}}/>, {createNodeMock:viewport.createNodeMock}) })
  await resolve(0)
  const input=renderer!.root.findByType('input')
  const name='A'.repeat(150)
  await act(async()=>input.props.onChange({target:{value:name}}))
  assert.ok(renderer!.root.findAll(node=>node.props.className==='playlist-pick-row').length > 0)
  assert.equal(renderer!.root.findAllByType('button').find(node=>text(node)==='创建并加入')!.props.disabled,true)
  await act(async()=>{await new Promise(done=>setTimeout(done,280))})
  assert.equal(requests[1].query.search,name)
  await resolve(1,0,125,true)
  assert.equal(renderer!.root.findAllByType('button').find(node=>text(node)==='创建并加入')!.props.disabled,true)
  await act(async()=>input.props.onChange({target:{value:name+'B'}}))
  await act(async()=>{await new Promise(done=>setTimeout(done,280))})
  await resolve(2,0,0,false)
  await click('创建并加入')
  assert.deepEqual(created,[name+'B'])
  assert.deepEqual(added,[[999,7]])
})

it('clears error on retry and ignores an old page after searching',async()=>{
  await act(async()=>{renderer=TestRenderer.create(<Picker videoIds={[1]} onCancel={()=>{}}/>, {createNodeMock:viewport.createNodeMock})})
  await act(async()=>requests[0].reject(new Error('read failed')))
  assert.match(text(renderer!.root), /清单读取失败/)
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,0)
  await click('重试');await resolve(1)
  await click('下一页')
  await act(async()=>renderer!.root.findByType('input').props.onChange({target:{value:'new'}}))
  await resolve(2,60)
  assert.ok(renderer!.root.findAll(node=>node.props.className==='playlist-pick-row').length > 0)
  await act(async()=>{await new Promise(done=>setTimeout(done,280))})
  await resolve(3,0,1)
  assert.equal(renderer!.root.findAll(node=>node.props.className==='playlist-pick-row').length,1)
})

it('keeps picker rows and retry when a later page fails',async()=>{
  await act(async()=>{renderer=TestRenderer.create(<Picker videoIds={[1]} onCancel={()=>{}}/>, {createNodeMock:viewport.createNodeMock})})
  await resolve(0)
  await click('下一页')
  await act(async()=>requests[1].reject(new Error('later failed')))
  const Grid=(await import('./ContinuousGrid')).default
  assert.equal(renderer!.root.findAllByType(Grid).length,1)
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,1)
  assert.match(text(renderer!.root), /later failed/)
  await click('重试')
  for (let index = 2; index < requests.length; index++) await resolve(index, Number(requests[index].query.offset ?? 0))
  assert.ok(renderer!.root.findAll(node=>text(node).includes('List 61')).length > 0)
})

it('destination picker shows loading, empty, and retry',async()=>{
  const Destination=(await import('./PlaylistDestinationPicker')).default
  await act(async()=>{renderer=TestRenderer.create(<Destination value="" onChange={()=>{}}/>, {createNodeMock:viewport.createNodeMock})})
  assert.equal(renderer!.root.findAllByProps({role:'status'}).length,1)
  await act(async()=>requests[0].reject(new Error('offline')))
  assert.match(text(renderer!.root), /清单读取失败/)
  assert.equal(renderer!.root.findAllByProps({role:'alert'}).length,0)
  await click('重试');await resolve(1,0,0)
  assert.match(text(renderer!.root), /暂无播放清单/)
})

it('import destination retains a selected identity across server pages without full options',async()=>{
  const Destination=(await import('./PlaylistDestinationPicker')).default
  function Host(){const [value,setValue]=React.useState(''),[label,setLabel]=React.useState('');return <Destination value={value} label={label} onChange={(id,name)=>{setValue(id);setLabel(name)}}/>}
  await act(async()=>{renderer=TestRenderer.create(<Host/>, {createNodeMock:viewport.createNodeMock})})
  assert.equal(fullCalls,0);await resolve(0)
  const DestinationGrid=(await import('./ContinuousGrid')).default
  assert.equal(renderer!.root.findByType(DestinationGrid).props.itemHeight,86)
  const row=renderer!.root.findAllByType('button').find(node=>node.props.title==='List 1')!
  await act(async()=>row.props.onClick())
  await click('下一页');await resolve(1,60)
  assert.match(text(renderer!.root), /已选：List 1/)
  assert.ok(renderer!.root.findAllByType('button').filter(node=>/^List \d+$/.test(String(node.props.title ?? ''))).length <= 8)
})
