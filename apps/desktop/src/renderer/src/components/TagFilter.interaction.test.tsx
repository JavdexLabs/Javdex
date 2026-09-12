import { continuousViewport } from '../test/continuousViewport'
import ContinuousGrid from './ContinuousGrid'
import assert from 'node:assert/strict'
import { afterEach, before, it } from 'node:test'
import React, { useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { TagFilterOptionsPage, TagOptionsQuery } from '@shared/commonTypes'

const requests: Array<{ query: TagOptionsQuery; resolve: (value: TagFilterOptionsPage) => void; reject: (error: Error) => void }> = []
const selections: number[][] = []
const fakeApi = { tags: {
  filterOptions(query: TagOptionsQuery) { return new Promise<TagFilterOptionsPage>((resolve,reject) => requests.push({ query, resolve,reject })) },
  list() { throw new Error('full catalog forbidden') },
  labels(ids: number[]) { return Promise.resolve(ids.map(id => ({ id,label:`Selected ${id}` }))) }
} }
Object.defineProperty(globalThis,'React',{ configurable:true,value:React })
Object.defineProperty(globalThis,'window',{ configurable:true,value:Object.assign(new EventTarget(),{ api:fakeApi,setTimeout,clearTimeout }) })
Object.defineProperty(globalThis,'document',{ configurable:true,value:new EventTarget() })
let Filter: typeof import('./TagFilter')['default']
let Parent: typeof import('./LibraryFilterPopover')['default']
before(async () => { Filter=(await import('./TagFilter')).default; Parent=(await import('./LibraryFilterPopover')).default })
let position = 0
let viewport = continuousViewport()
let renderer: TestRenderer.ReactTestRenderer | undefined
function Host({ initial = [], variant = 'popover' }: { initial?: number[]; variant?: 'default'|'popover' }) {
  const [selected,setSelected] = useState(initial)
  return <Filter selected={selected} variant={variant} showInlineChips={false} onChange={ids => { selections.push(ids);setSelected(ids) }} />
}
async function mount(initial: number[] = [], variant: 'default'|'popover' = 'popover') {
  await act(async () => { renderer=TestRenderer.create(<Host initial={initial} variant={variant} />, { createNodeMock: viewport.createNodeMock }) })
}
function options() { return renderer!.root.findAllByType('button').filter(n => n.props.role==='option') }
function optionFor(id: number) {
  return options().find(node => {
    const name = node.findAll(child => child.props.className === 'tag-chip-cloud-name')[0]
    return name && String(name.children[0]) === `Tag ${id}`
  })
}
async function click(label: string) {
  if (label==='下一页'||label==='上一页') {
    const grids = renderer!.root.findAllByType(ContinuousGrid)
    if (grids.length) {
      position=Math.max(0,position+(label==='下一页'?100:-100));await viewport.scroll(renderer!,position);return
    }
    const cloud = renderer!.root.findAll(node => node.props.className === 'tag-chip-cloud')[0]
    await act(async () => cloud.props.onScroll({ currentTarget: { scrollTop: label==='下一页' ? 9840 : 0, clientHeight: 160, scrollHeight: 10000 } }))
    return
  }
  const node=renderer!.root.findAllByType('button').find(n => React.Children.toArray(n.props.children).filter(value => typeof value === 'string' || typeof value === 'number').join('')===label)!
  assert.ok(node,label);assert.equal(Boolean(node.props.disabled),false)
  await act(async () => node.props.onClick())
}
async function resolve(index: number, ids: number[], hasMore=false) {
  await act(async () => requests[index].resolve({ items:ids.map(id=>({ id,label:`Tag ${id}`,video_count:id })),hasMore }))
}
afterEach(async () => { await act(async () => renderer?.unmount());renderer=undefined;viewport=continuousViewport();position=0;requests.length=0;selections.length=0 })
function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child as TestRenderer.ReactTestInstance)).join('')
}

it('loads on open only, pages without full catalog reads and preserves cross-page selection', async () => {
  await mount([], 'default');assert.equal(requests.length,0)
  await click('添加标签');assert.deepEqual(requests[0].query,{ search:'',offset:0,limit:100 })
  await resolve(0,[1],true)
  assert.ok(renderer!.root.findAllByType('input').some(node => node.props.type === 'checkbox'))
  await click('下一页');assert.equal(requests[1].query.offset,100)
  await act(async () => renderer!.unmount());renderer=undefined;viewport=continuousViewport();position=0;requests.length=0
  await mount();await resolve(0,[1],true)
  assert.equal(optionFor(1)?.props.className, 'tag-chip-cloud-item')
  await act(async () => optionFor(1)!.props.onClick())
  assert.equal(requests.length,1,'selection alone does not reload candidates')
  await click('下一页');await resolve(1,[101])
  await act(async () => optionFor(101)!.props.onClick())
  assert.deepEqual(selections.at(-1),[1,101])
  await click('上一页');assert.equal(requests.length,2,'retained page is reused')
  assert.equal(optionFor(1)?.props['aria-selected'],true)
})

it('debounces and resets search, rejecting stale page/search responses', async () => {
  await mount();assert.deepEqual(requests[0].query,{ search:'',offset:0,limit:100 })
  await resolve(0,[1],true);await click('下一页')
  await act(async () => renderer!.root.findByType('input').props.onChange({ target:{ value:'New' } }))
  assert.equal(optionFor(1)?.props.disabled, false)
  await act(async () => optionFor(1)!.props.onClick())
  assert.deepEqual(selections.at(-1),[1])
  await resolve(1,[101]);assert.equal(optionFor(1)?.props['aria-selected'],true)
  await act(async () => { await new Promise(done => setTimeout(done,270)) })
  assert.deepEqual(requests[2].query,{ search:'New',offset:0,limit:100 })
  await resolve(2,[2]);assert.equal(options()[0].props['aria-selected'],false)
})

it('shows failure with explicit retry and enforces 100 selections while allowing removal', async () => {
  await mount(Array.from({length:100},(_,i)=>i+1))
  await act(async () => requests[0].reject(new Error('unavailable')))
  assert.equal(renderer!.root.findAll(n=>n.props.role==='alert').length,1)
  assert.equal(requests.length,1)
  await click('重试');await resolve(1,[1,101])
  assert.equal(optionFor(101)!.props.disabled,true)
  await act(async () => optionFor(1)!.props.onClick())
  assert.equal(optionFor(101)!.props.disabled,false)
  await act(async () => optionFor(101)!.props.onClick())
  assert.equal(selections.at(-1)!.length,100)
  assert.ok(selections.at(-1)!.includes(101))
})

it('unmounts candidates with the actual parent popover and ignores late responses on reopen', async () => {
  const props = { onClose:()=>{},years:[],state:{status:'all' as const,pendingScrape:'all' as const,year:'all' as const,codePrefix:'',sortBy:'add_time' as const,sortDir:'desc' as const,tagIds:[],resourceKinds:[]},onChange:()=>{},onReset:()=>{},anchorRef:{current:null} }
  await act(async () => { renderer=TestRenderer.create(<Parent {...props} open={false} />, { createNodeMock: viewport.createNodeMock }) })
  assert.equal(requests.length,0)
  await act(async () => renderer!.update(<Parent {...props} open />))
  assert.equal(requests.length,1)
  await act(async () => renderer!.update(<Parent {...props} open={false} />))
  await resolve(0,[1]);assert.equal(options().length,0)
  await act(async () => renderer!.update(<Parent {...props} open />))
  assert.equal(requests.length,2);await resolve(1,[2])
  assert.equal(options().length,1)
})

it('uses 无标签 for an empty default picker', async () => {
  await mount([], 'default')
  await click('添加标签')
  await resolve(0, [])
  assert.match(text(renderer!.root), /无标签/)
  assert.doesNotMatch(text(renderer!.root), /没有匹配项/)
})
