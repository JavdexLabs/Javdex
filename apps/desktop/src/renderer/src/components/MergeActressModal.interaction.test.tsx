import { continuousViewport } from '../test/continuousViewport'
import assert from 'node:assert/strict'
import {afterEach,it} from 'node:test'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import type {ActressDetail,ActressMergeCandidatePage,ActressMergeCandidateQuery,ActressMergeInput} from '@shared/actressTypes'
import type {ElectronApi} from '../../../preload/index'
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
const calls:ActressMergeCandidateQuery[]=[],merges:ActressMergeInput[]=[]
const heldPages:Array<ReturnType<typeof deferred<ActressMergeCandidatePage>>>=[]
let holdPage=false,failPage=false,failMerge=false,heldMerge:ReturnType<typeof deferred<void>>|undefined,merged=0,cancelled=0
function page(query:ActressMergeCandidateQuery):ActressMergeCandidatePage {
 const rows=Array.from({length:101},(_,i)=>({id:i+2,main_name:`Candidate-${i+2}`,avatar_path:null,gender:'female' as const,video_count:i+1}))
  .filter(row=>row.id!==query.keepId&&(!query.search||row.main_name.includes(query.search)))
 const offset=query.offset??0
 return {items:rows.slice(offset,offset+40),hasMore:rows.length>offset+40,offset}
}
const fake={actresses:{list:()=>{throw new Error('Full candidate list forbidden')},
 mergeCandidates:async(query:ActressMergeCandidateQuery)=>{calls.push(query);if(failPage){failPage=false;throw new Error('Page failure')}if(holdPage){holdPage=false;const held=deferred<ActressMergeCandidatePage>();heldPages.push(held);return held.promise}return page(query)},
 merge:async(input:ActressMergeInput)=>{merges.push(input);if(heldMerge)await heldMerge.promise;if(failMerge)throw new Error('Merge failure');return true}
}} as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:fake})})
Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{style:{overflow:''}}}})
let position = 0
let viewport = continuousViewport()
let renderer:TestRenderer.ReactTestRenderer|undefined
let Component:typeof import('./MergeActressModal')['default']
const keep=(id:number):ActressDetail=>({id,main_name:`Keep-${id}`,gender:'female',avatar_path:null,videos:[],gallery:[]} as unknown as ActressDetail)
const element=(id:number)=><Component keepActress={keep(id)} keepVideoCount={keep(id).videos.length} onCancel={()=>cancelled++} onMerged={()=>merged++}/>
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})}
async function mount(){Component=(await import('./MergeActressModal')).default;await act(async()=>{renderer=TestRenderer.create(element(1), { createNodeMock: viewport.createNodeMock })});await settle()}
function text(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('')}
function button(label:string){const result=renderer!.root.findAllByType('button').find(node=>text(node)===label);assert.ok(result,label);return result}
async function click(label:string){if(label==='下一页'||label==='上一页'){position=Math.max(0,position+(label==='下一页'?40:-40));await viewport.scroll(renderer!,position);return}const node=button(label);assert.ok(!node.props.disabled);await act(async()=>node.props.onClick());await settle()}
function options(){return renderer!.root.findAllByType('button').filter(node=>node.props.role==='option')}
async function choose(id:number){const node=options().find(node=>node.props['aria-label']===`选择合并演员 Candidate-${id}`);assert.ok(node);assert.ok(!node.props.disabled);await act(async()=>node.props.onClick());await settle()}
function radios(){return renderer!.root.findAllByType('input').filter(node=>node.props.name==='merge-main-name')}
async function search(value:string){const input=renderer!.root.findAllByType('input').find(node=>node.props.type==='search')!;await act(async()=>input.props.onChange({target:{value}}))}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;viewport=continuousViewport();position=0;calls.length=0;merges.length=0;heldPages.length=0;holdPage=false;failPage=false;failMerge=false;heldMerge=undefined;merged=0;cancelled=0})

it('pages40 candidates and preserves selection and name plan across pages and search',async()=>{
 await mount();assert.deepEqual(calls,[{keepId:1,search:'',limit:40,offset:0}]);assert.ok(options().length > 0 && options().length < 40)
 await choose(2);await act(async()=>radios()[1].props.onChange())
 await click('下一页');assert.equal(calls.at(-1)?.offset,40);assert.equal(radios()[1].props.checked,true)
 await click('下一页');assert.ok(options().length > 0 && options().length <= 8);assert.equal(renderer!.root.findAllByType('button').some(n=>text(n)==='下一页'),false)
 await search('not-found');await act(async()=>{await new Promise(resolve=>setTimeout(resolve,330))});await settle()
 assert.equal(calls.at(-1)?.offset,0);assert.equal(options().length,0);assert.equal(radios()[1].props.checked,true)
 await click('确认合并');assert.deepEqual(merges,[{keepId:1,mergeId:2,mainNameFrom:'merge'}]);assert.equal(merged,1)
})
it('retries page failures without losing the selected merge plan',async()=>{
 await mount();await choose(2);await act(async()=>radios()[1].props.onChange());failPage=true
 await click('下一页');assert.ok(renderer!.root.findAllByProps({role:'alert'}).length);assert.ok(options().length <= 1)
 await click('重试');assert.ok(options().length > 0 && options().length < 40);assert.equal(radios()[1].props.checked,true)
})
it('ignores old page responses while a changed search is debouncing',async()=>{
 await mount();holdPage=true;await click('下一页');await search('Candidate-100')
 await act(async()=>heldPages[0].resolve(page({keepId:1,offset:40})));await settle();assert.ok(options().length > 0)
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,330))});await settle()
 assert.equal(options().length,1);assert.equal(options()[0].props['aria-label'],'选择合并演员 Candidate-100')
})
it('locks a captured merge against duplicate submission and retains plan on failure',async()=>{
 await mount();await choose(2);await act(async()=>radios()[1].props.onChange());heldMerge=deferred<void>();failMerge=true
 const submit=button('确认合并');await act(async()=>{submit.props.onClick();submit.props.onClick()});await settle()
 assert.equal(merges.length,1);assert.equal(button('取消').props.disabled,true)
 assert.ok(options().every(node=>node.props.disabled));assert.ok(radios().every(node=>node.props.disabled))
 await act(async()=>heldMerge!.resolve());await settle();assert.equal(merged,0);assert.equal(radios()[1].props.checked,true)
 failPage=true;await click('下一页');assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node=>text(node)==='Merge failure'))
 await click('重试');assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(node=>text(node)==='Merge failure'));assert.equal(radios()[1].props.checked,true)
 failMerge=false;heldMerge=undefined;await click('确认合并');assert.equal(merged,1);assert.equal(merges.length,2)
})
it('resets session on keep identity change and ignores old page and merge completion',async()=>{
 holdPage=true;await mount();await act(async()=>renderer!.update(element(9)));await settle()
 await act(async()=>heldPages[0].resolve({items:[],hasMore:false,offset:0}));await settle();assert.ok(options().length > 0 && options().length < 40)
 await choose(2);heldMerge=deferred<void>();await click('确认合并')
 await act(async()=>renderer!.update(element(10)));await settle();assert.equal(button('确认合并').props.disabled,true)
 await act(async()=>heldMerge!.resolve());await settle();assert.equal(merged,0);assert.equal(calls.at(-1)?.keepId,10)
})
it('resets the name plan only when choosing a different merge candidate or clearing selection',async()=>{
 await mount();await choose(2);await act(async()=>radios()[1].props.onChange());await choose(3)
 assert.equal(radios()[0].props.checked,true);await choose(3);assert.equal(button('确认合并').props.disabled,true)
})
