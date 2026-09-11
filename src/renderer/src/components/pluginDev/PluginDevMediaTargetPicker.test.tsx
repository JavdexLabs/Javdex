import { continuousViewport } from '../../test/continuousViewport'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React, { useState } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { ElectronApi } from '../../../../preload/index'
import type { ActressPickerPage, ActressPickerQuery } from '@shared/actressTypes'
const fullName='A'.repeat(150)
const rows=Array.from({length:101},(_,i)=>({id:i+1,main_name:i===0?'A'.repeat(128)+'…':`Candidate-${String(i+1).padStart(3,'0')}`,avatar_path:null}))
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
let pageHold:ReturnType<typeof deferred<ActressPickerPage>>|null=null,choiceHold:ReturnType<typeof deferred<string|null>>|null=null
let pageOverride: typeof rows | null=null
let getFailure=false
let pageFailure=false,choiceValue:string|null|undefined,choices=0,closed=0
const calls:ActressPickerQuery[]=[],added:string[]=[],videoCalls:unknown[]=[]
function page(q:ActressPickerQuery):ActressPickerPage {const all=(pageOverride??rows).filter(row=>!q.search||row.main_name.includes(q.search));const offset=q.offset??0;return {items:all.slice(offset,offset+40),hasMore:all.length>offset+40,offset}}
const fake={actresses:{list:()=>{throw new Error('Full actors forbidden')},get:()=>{throw new Error('Wide actor detail forbidden')},testTargetPage:async(q:ActressPickerQuery)=>{calls.push(q);if(pageFailure){pageFailure=false;throw new Error('Page failed')}if(pageHold)return pageHold.promise;return page(q)},testTargetGet:async(id:number)=>{choices++;if(getFailure)throw new Error('Identity failed');if(choiceHold)return choiceHold.promise;return choiceValue!==undefined?choiceValue:id===1?fullName:rows[id-1].main_name}},videos:{list:async(...args:unknown[])=>{videoCalls.push(args);return {items:[],total:0}}}} as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:fake})})
Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{style:{overflow:''}}}})
let viewport=continuousViewport(), position=0
let Component:typeof import('./PluginDevMediaTargetPicker')['default'],renderer:TestRenderer.ReactTestRenderer|undefined
function Harness({kind='actress',initial=[]}:{kind?:'actress'|'video';initial?:string[]}){const[selected,setSelected]=useState(initial);const[open,setOpen]=useState(true);return open?<Component kind={kind} selectedValues={selected} onAdd={value=>{added.push(value);setSelected(previous=>[...previous,value])}} onClose={()=>{closed++;setOpen(false)}}/>:null}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))})}
async function mount(initial:string[]=[]){Component=(await import('./PluginDevMediaTargetPicker')).default;await act(async()=>{renderer=TestRenderer.create(<Harness initial={initial}/>, {createNodeMock:viewport.createNodeMock})});await settle()}
const options=()=>renderer!.root.findAll(node=>node.type==='button'&&String(node.props['aria-label']??'').startsWith('添加测试演员'))
function label(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:label(child)).join('')}
const button=(name:string)=>renderer!.root.findAllByType('button').find(node=>label(node)===name)!
async function click(node:TestRenderer.ReactTestInstance){await act(async()=>node.props.onClick());await settle()}
async function scroll(step:number){position=Math.max(0,position+step);await viewport.scroll(renderer!,position);await settle()}
async function search(value:string){await act(async()=>renderer!.root.findByProps({'aria-label':'搜索测试目标'}).props.onChange({target:{value}}))}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;viewport=continuousViewport();position=0;pageHold=null;choiceHold=null;pageFailure=false;pageOverride=null;getFailure=false;choiceValue=undefined;choices=0;closed=0;calls.length=0;added.length=0;videoCalls.length=0})
it('pages40/40/21, resolves full names and retains selected long identities when returning',async()=>{
 await mount();assert.ok(options().length > 0 && options().length <= 8)
 await click(options()[0]);assert.deepEqual(added,[fullName]);assert.equal(options()[0].props.disabled,true)
 await scroll(40);assert.ok(options().length > 0 && options().length <= 8)
 await scroll(40);assert.ok(options().length > 0 && options().length <= 8)
 await scroll(-40);await scroll(-40);assert.equal(options()[0].props.disabled,true)
 assert.deepEqual(calls.map(q=>q.offset),[0,40,80])
})
it('retries page failures and isolates a stale page during raw search debounce',async()=>{
 await mount();pageFailure=true;await scroll(40);assert.ok(options().length <= 1)
 await click(button('重试'));assert.ok(options().length > 0 && options().length <= 8)
 pageHold=deferred();await scroll(40);const old=pageHold;pageHold=null
 await search('Candidate-100');old.resolve(page({offset:80}));await settle();assert.equal(options().length,0)
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280))});await settle()
 assert.equal(options().length,1);assert.equal(calls.at(-1)!.offset,0)
})
it('ignores choice completion after search or close and suppresses same-tick duplicate clicks',async()=>{
 await mount();choiceHold=deferred();const row=options()[0]
 await act(async()=>{row.props.onClick();row.props.onClick()});assert.equal(choices,1)
 const first=choiceHold;choiceHold=null;await search('Candidate-002');first.resolve(fullName);await settle();assert.deepEqual(added,[])
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280))});await settle()
 choiceHold=deferred();await click(options()[0]);const second=choiceHold
 await click(button('完成'));second.resolve('Candidate-002');await settle()
 assert.equal(closed,1);assert.deepEqual(added,[])
})
it('reports missing or unrepresentable names without adding incorrect targets',async()=>{
 await mount();choiceValue=null;await click(options()[0]);assert.deepEqual(added,[])
 choiceValue='Doe, Jane';await click(options()[0]);assert.deepEqual(added,[])
 assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node=>label(node).includes('分隔符')))
 choiceValue='Valid';await click(options()[0]);assert.deepEqual(added,['Valid'])
})
it('enforces existing eight-target limit and preserves video query behavior after kind switch',async()=>{
 await mount(Array.from({length:8},(_,i)=>'Selected-'+(i%4)));await click(options()[0]);assert.deepEqual(added,[])
 assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node=>label(node).includes('8 个目标')))
 await act(async()=>renderer!.update(<Harness kind="video"/>));await settle()
 assert.equal(videoCalls.length,1);assert.equal(options().length,0)
 assert.equal((videoCalls[0] as unknown[])[1] && ((videoCalls[0] as unknown[])[1] as {limit:number}).limit,60)
})

it('recognizes existing long targets on a fresh mount without confusing a common preview prefix',async()=>{
 await mount([fullName]);assert.equal(options()[0].props.disabled,true)
 await act(async()=>renderer?.unmount());renderer=undefined
 await mount(['A'.repeat(149)+'B']);assert.equal(options()[0].props.disabled,false)
 await click(options()[0]);assert.deepEqual(added,[fullName])
})
it('ignores a held actress choice after switching to video',async()=>{
 await mount();choiceHold=deferred();await click(options()[0]);const held=choiceHold
 await act(async()=>renderer!.update(<Harness kind="video"/>));await settle()
 held.resolve(fullName);await settle();assert.deepEqual(added,[])
 assert.equal(videoCalls.length,1)
})

it('bounds long-label reconciliation concurrency and stops scheduling after kind switch',async()=>{
 pageOverride=rows.slice(0,40).map(row=>({...row,main_name:'A'.repeat(128)+'…'}))
 choiceHold=deferred();await mount([fullName]);assert.equal(choices,4)
 const held=choiceHold
 await act(async()=>renderer!.update(<Harness kind="video"/>));held.resolve(fullName);await settle()
 assert.equal(choices,4);assert.deepEqual(added,[])
})
it('retries failed long-label selection reconciliation',async()=>{
 getFailure=true;await mount([fullName])
 assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node=>label(node).includes('已选状态无法确认')))
 getFailure=false;await click(button('重试'));assert.equal(options()[0].props.disabled,true)
})
