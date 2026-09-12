import type { ActressPickerPage, ActressPickerQuery } from '@shared/actressTypes'
import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ElectronApi } from '../../../preload/index'
import type { ActressConflictQueueQuery, ActressNameConflictGroup, ResolveActressConflictInput } from '@shared/actressConflictTypes'
import type { ConflictReviewViewModel } from './useConflictReviewController'
import { pendingCenterPath, pendingItemKey, parsePendingCenterSearch } from '../listView/pendingRoutes'
import { actressKeys } from '../query/queryKeys'
function deferred<T>() {let resolve!:(value:T)=>void, reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const name=(id:number)=>`actor-${String(id).padStart(3,'0')}`
const idOf=(key:string)=>Number(key.slice(6))
function group(id:number):ActressNameConflictGroup{return {
  status:'conflict',normalizedName:name(id),displayName:`Actor-${id}`,currentOwner:null,claimants:[],pendingNameClaims:[],mergePairs:[],
  candidates:[{pendingId:id,revision:1,actressId:id+1000,actressRevision:1,actressMainName:`Candidate-${id}`,actressAvatarPath:null,
    plugin:{name:'Fixture',source:'builtin'},queryName:'Fixture',selectedFields:['aliases'],applicableFields:['aliases'],mode:'fillEmpty',
    result:{aliases:[name(id)]},warnings:[],createdAt:'2026',resources:[],conflicts:[{name:name(id),normalizedName:name(id),type:'alias'}],
    fieldImpacts:[],fieldImpactsWhenAssignedToCandidate:[],willApplyAfterDecision:true,remainingConflictCountAfterDecision:0}]
}}
let ids=Array.from({length:120},(_,i)=>i+1), failPage=false, failDetail=false
let includeScan=false, staleResolution=false
const inspections:string[]=[]
let holdDetail:string|undefined
const heldDetails:Array<{name:string}&ReturnType<typeof deferred<ActressNameConflictGroup|null>>>=[]
const pages:ActressConflictQueueQuery[]=[], details:string[]=[], resolutions:ResolveActressConflictInput[]=[]
let heldMutation:ReturnType<typeof deferred<void>>|undefined
let navigate:NavigateFunction,location=''
const pickerCalls: ActressPickerQuery[] = [], pickerGets: number[] = []
let failPicker = false, holdPicker = false, holdChoice = false
const heldPicker: Array<ReturnType<typeof deferred<ActressPickerPage>>> = []
const heldChoices: Array<ReturnType<typeof deferred<{ main_name: string; revision: number } | null>>> = []
function pickerResult(query: ActressPickerQuery): ActressPickerPage {
 const all = Array.from({length:101},(_,i)=>({id:2001+i,main_name:`Choice-${2001+i}`,avatar_path:null}))
 const matched=all.filter(item=>!query.search||item.main_name.includes(query.search))
 const offset=query.offset??0
 return {items:matched.slice(offset,offset+40),hasMore:matched.length>offset+40,offset}
}
const fakeApi={
  mediaLibraries:{list:async()=>[]},scan:{countPendingQueue:async()=>includeScan?1:0,pagePendingQueue:async()=>({items:includeScan?[{kind:'group',id:1,libraryId:1,revision:1,label:'Scan item',resourceCount:0}]:[],total:includeScan?1:0,offset:0}),getPendingGroup:async()=>null},
  scrape:{countPending:async()=>0,pagePending:async()=>({items:[],total:0,offset:0})},
  actresses:{list:()=>{throw new Error('Full actress candidates are forbidden')},
    pickerPage:async(query:ActressPickerQuery)=>{pickerCalls.push(query);if(failPicker){failPicker=false;throw new Error('picker failed')}if(holdPicker){holdPicker=false;const held=deferred<ActressPickerPage>();heldPicker.push(held);return held.promise}return pickerResult(query)},
    get:async()=>{throw new Error('Full actress detail forbidden for choices')},
    pickerGet:async(id:number)=>{if(id<2000)return null;pickerGets.push(id);if(holdChoice){holdChoice=false;const held=deferred<{main_name:string;revision:number}|null>();heldChoices.push(held);return held.promise}return {main_name:`Current-${id}`,revision:7}}
  },
  actressScrape:{
    listConflicts:()=>{throw new Error('Full actor queue is forbidden')},
    conflictSummary:async()=>({groupCount:ids.length}),
    pageConflicts:async(query:ActressConflictQueueQuery)=>{
      pages.push(query);if(failPage){failPage=false;throw new Error('page failure')}
      const rank=query.anchorName?ids.indexOf(idOf(query.anchorName)):-1
      const offset=rank>=0?Math.floor(rank/50)*50:Math.min(query.offset??0,Math.max(0,Math.floor((ids.length-1)/50)*50))
      return {total:ids.length,offset,items:ids.slice(offset,offset+50).map(id=>({normalizedName:name(id),displayName:`Actor-${id}`,status:'conflict',candidateCount:1,pendingNameClaimCount:0,avatarPath:null}))}
    },
    getConflict:async(key:string)=>{
      details.push(key);if(failDetail){failDetail=false;throw new Error('detail failure')}
      if(holdDetail===key){holdDetail=undefined;const held={name:key,...deferred<ActressNameConflictGroup|null>()};heldDetails.push(held);return held.promise}
      return ids.includes(idOf(key))?group(idOf(key)):null
    },
    inspectConflictName:async(input:{name:string})=>{inspections.push(input.name);return {normalizedName:'elsewhere',status:'conflict'}},
    validateIllegalNameReplacements:async()=>({status:'valid'}),
    discardConflict:async(input:{pendingId:number})=>{
      if(heldMutation)await heldMutation.promise
      if(staleResolution)throw new Error('Fixture stale discard')
      ids=ids.filter(id=>id!==input.pendingId);return {remainingPending:ids.length}
    },
    resolveConflict:async(input:ResolveActressConflictInput)=>{
      resolutions.push(input);if(heldMutation)await heldMutation.promise
      if(staleResolution)return {status:'stale',message:'Fixture stale snapshot'}
      if('snapshot' in input)ids=ids.filter(id=>name(id)!==input.snapshot.normalizedName)
      return {status:'success',remainingPending:ids.length}
    }
  }
} as unknown as ElectronApi
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:fakeApi})})
Object.defineProperty(globalThis,'document',{configurable:true,value:{activeElement:null,body:{style:{overflow:''}}}})
let renderer:TestRenderer.ReactTestRenderer|undefined,client:QueryClient|undefined
let Pane:typeof import('./PendingActressConflictPane')['default']
function Probe():null{navigate=useNavigate();location=useLocation().search;return null}
const settle=async()=>{await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))})}
async function mount(url=pendingCenterPath({type:'actress'})):Promise<void>{
 const Page=(await import('./PendingCenterPage')).default;Pane=(await import('./PendingActressConflictPane')).default
 client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client!}><MemoryRouter initialEntries={[url]}><Probe/><Page/></MemoryRouter></QueryClientProvider>)})
 await settle();await settle();await settle()
}
const vm=():ConflictReviewViewModel=>renderer!.root.findByType(Pane).props.vm
function text(node:TestRenderer.ReactTestInstance):string{return node.children.map(child=>typeof child==='string'?child:text(child)).join('')}
async function click(label:string):Promise<void>{const button=renderer!.root.findAllByType('button').find(node=>text(node)===label);assert.ok(button,label);assert.ok(!button.props.disabled);await act(async()=>button.props.onClick());await settle();await settle();await settle()}
async function chooseOwner():Promise<void>{const candidate=vm().queue.selectedGroup!.candidates[0];await act(async()=>vm().detail.selectOwner({actressId:candidate.actressId,revision:candidate.actressRevision,mainName:candidate.actressMainName}));await settle()}
afterEach(async()=>{await act(async()=>renderer?.unmount());client?.clear();renderer=undefined;client=undefined;ids=Array.from({length:120},(_,i)=>i+1);failPage=false;failDetail=false;holdDetail=undefined;heldDetails.length=0;pages.length=0;details.length=0;resolutions.length=0;heldMutation=undefined;includeScan=false;staleResolution=false;inspections.length=0;pickerCalls.length=0;pickerGets.length=0;heldPicker.length=0;heldChoices.length=0;failPicker=false;holdPicker=false;holdChoice=false})
it('locates a deep actor group and loads only its detail before paging',async()=>{
 await mount(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(110))}))
 assert.equal(pages[0].anchorName,name(110));assert.deepEqual(details,[name(110)])
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).actressOffset,100)
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(110))
 assert.equal(renderer!.root.findAllByType('button').filter(node=>node.props['aria-current']!==undefined).length,20)
 await click('上一页');assert.equal(vm().queue.selectedGroup!.normalizedName,name(51))
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).actressOffset,50)
 assert.ok(client!.getQueryCache().findAll({queryKey:actressKeys.conflicts()}).filter(query=>query.state.data!==undefined).length<=2)
})
it('keeps page and detail failures distinct and retries without a full list',async()=>{
 failPage=true;await mount();assert.ok(text(renderer!.root).includes('演员冲突队列读取失败'));assert.equal(details.length,0)
 failDetail=true;await click('重试');assert.ok(text(renderer!.root).includes('演员冲突详情读取失败'))
 await click('重试');assert.equal(vm().queue.selectedGroup!.normalizedName,name(1))
})
it('ignores a late old detail after selecting another group',async()=>{
 holdDetail=name(1);await mount()
 await click('Actor-2刮削 1 · 历史 0')
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(2))
 await act(async()=>heldDetails[0].resolve(group(1)));await settle()
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(2))
})
it('preserves an explicit decision across a category switch and detail overlay',async()=>{
 await mount();await chooseOwner()
 await act(async()=>navigate('/pending?type=scan'));await settle()
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(1))})));await settle();await settle()
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1001)
 const before=details.length
 await act(async()=>navigate(`/pending/actress/1001?type=actress&item=actress:${name(1)}`));await settle()
 assert.equal(details.length,before)
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(1))})));await settle();await settle()
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1001)
})
it('applies an ownership decision then clamps a deleted last page',async()=>{
 ids=Array.from({length:101},(_,i)=>i+1)
 await mount(pendingCenterPath({type:'actress',actressOffset:100}));await chooseOwner()
 await act(async()=>vm().detail.confirmOwnership());await settle();await settle();await settle()
 assert.equal(resolutions.length,1);assert.ok('snapshot' in resolutions[0]);assert.equal(resolutions[0].snapshot.normalizedName,name(101))
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).actressOffset,50)
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(51))
})
it('does not let a completed old mutation reset a newer group decision',async()=>{
 await mount();await chooseOwner();heldMutation=deferred<void>()
 await act(async()=>vm().detail.confirmOwnership());await settle()
 await click('Actor-2刮削 1 · 历史 0');await chooseOwner()
 await act(async()=>vm().detail.openIllegalName())
 assert.equal(vm().dialogs.replacement.kind,'illegal')
 await act(async()=>heldMutation!.resolve());await settle();await settle();await settle()
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(2))
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1002)
 assert.equal(vm().dialogs.replacement.kind,'illegal')
})

it('keeps actor paging in the all-domain view even when a scan item comes first',async()=>{
 includeScan=true;await mount('/pending')
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).item?.domain,'scan')
 await click('下一页')
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).item?.id,name(51))
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(51))
 assert.equal(renderer!.root.findAllByType('button').filter(node=>node.props['aria-current']!==undefined).length,51)
})
it('asks the server about names outside the current page before editing',async()=>{
 await mount();await act(async()=>vm().detail.openEditName())
 await act(async()=>vm().dialogs.editName.change('Name outside this page'))
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280))});await settle()
 assert.ok(inspections.includes('Name outside this page'))
 assert.equal(vm().detail.editInspection.status,'conflict')
})
it('keeps a stale resolution on the same group and requires a renewed decision',async()=>{
 staleResolution=true;await mount();await chooseOwner()
 await act(async()=>vm().detail.confirmOwnership());await settle();await settle();await settle()
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(1))
 const selection=vm().detail.selection
 assert.ok(selection,'stale result must restore a reviewable group')
 assert.equal(selection.proposedOwner,null)
 assert.ok(vm().queue.staleMessage)
})

it('isolates an old completion after navigating A to B and back to A',async()=>{
 staleResolution=true;await mount();await chooseOwner();heldMutation=deferred<void>()
 await act(async()=>vm().detail.confirmOwnership());await settle()
 await click('Actor-2刮削 1 · 历史 0')
 await click('Actor-1刮削 1 · 历史 0');await chooseOwner()
 await act(async()=>vm().detail.openIllegalName())
 await act(async()=>heldMutation!.resolve());await settle();await settle();await settle()
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1001)
 assert.equal(vm().dialogs.replacement.kind,'illegal')
 assert.equal(vm().queue.staleMessage,null)
 assert.equal(vm().busy.resolving,false)
})

it('stays on the deep-linked page after its selected group is resolved',async()=>{
 await mount(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(110))}));await chooseOwner()
 await act(async()=>vm().detail.confirmOwnership());await settle();await settle();await settle()
 assert.equal(parsePendingCenterSearch(new URLSearchParams(location)).actressOffset,100)
 assert.equal(vm().queue.selectedGroup!.normalizedName,name(101))
})

it('does not close a new discard dialog when an old A-B-A discard fails',async()=>{
 staleResolution=true;await mount();heldMutation=deferred<void>()
 await act(async()=>vm().detail.requestDiscard(vm().queue.selectedGroup!.candidates[0]))
 await act(async()=>vm().dialogs.discard.confirm());await settle()
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(2))})));await settle();await settle()
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(1))})));await settle();await settle()
 await chooseOwner()
 await act(async()=>vm().detail.requestDiscard(vm().queue.selectedGroup!.candidates[0]))
 await act(async()=>heldMutation!.resolve());await settle();await settle();await settle()
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1001)
 assert.equal(vm().dialogs.discard.candidate?.pendingId,1)
 assert.equal(vm().dialogs.discard.busy,false)
})


it('pages owner candidates and preserves a selected actor outside the current page',async()=>{
 await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 assert.deepEqual(pickerCalls,[{search:'',limit:40,offset:0}]);assert.equal(vm().dialogs.otherOwner.options.length,40)
 await act(async()=>vm().dialogs.otherOwner.window.onVisibleRange(40,45));await settle()
 assert.equal(vm().dialogs.otherOwner.window.getItem(40)?.id,2041)
 await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.window.getItem(40)!));await settle()
 assert.deepEqual(pickerGets,[2041]);assert.equal(vm().detail.selection?.proposedOwner?.revision,7)
 assert.equal(vm().dialogs.otherOwner.selected?.main_name,'Current-2041');assert.equal(vm().dialogs.otherOwner.open,false)
 await act(async()=>vm().detail.openOtherOwner());await settle()
 assert.equal(vm().dialogs.otherOwner.options.length,40)
 assert.equal(vm().dialogs.otherOwner.selected?.id,2041)
 await act(async()=>vm().dialogs.otherOwner.window.onVisibleRange(40,45));await settle()
 assert.equal(vm().dialogs.otherOwner.selected?.id,2041)
 await act(async()=>vm().dialogs.otherOwner.window.onVisibleRange(80,85));await settle()
 assert.equal(vm().dialogs.otherOwner.window.total,101);assert.ok(vm().dialogs.otherOwner.options.length<=120)
})

it('retries picker failures and invalidates old page replies immediately while search debounces',async()=>{
 failPicker=true;await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 assert.equal(vm().dialogs.otherOwner.error,'picker failed');assert.equal(vm().dialogs.otherOwner.options.length,0)
 await act(async()=>vm().dialogs.otherOwner.retry());await settle();assert.equal(vm().dialogs.otherOwner.error,null)
 holdPicker=true;await act(async()=>vm().dialogs.otherOwner.window.onVisibleRange(40,45));await settle()
 await act(async()=>vm().dialogs.otherOwner.changeSearch('2099'))
 await act(async()=>heldPicker[0].resolve(pickerResult({offset:40})));await settle()
 assert.equal(vm().dialogs.otherOwner.options.length,0)
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,280))});await settle()
 assert.deepEqual(vm().dialogs.otherOwner.options.map(item=>item.id),[2099])
 assert.equal(pickerCalls.at(-1)?.offset,0)
})

it('ignores an old actor choice after closing and reopening the same picker',async()=>{
 await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 holdChoice=true;await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[0]));await settle()
 await act(async()=>vm().dialogs.otherOwner.close());await act(async()=>vm().detail.openOtherOwner());await settle()
 await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[1]));await settle()
 await act(async()=>heldChoices[0].resolve({main_name:'Old choice',revision:9}));await settle()
 assert.equal(vm().dialogs.otherOwner.selected?.id,2002)
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,2002)
 assert.equal(vm().dialogs.otherOwner.choosingId,null)
})

it('keeps the newest actor choice when earlier detail reads finish later',async()=>{
 await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 holdChoice=true;await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[0]));await settle()
 await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[1]));await settle()
 await act(async()=>heldChoices[0].resolve({main_name:'Old choice',revision:9}));await settle()
 assert.equal(vm().dialogs.otherOwner.selected?.id,2002)
})


it('keeps a direct group-owner decision after an older external-owner detail returns',async()=>{
 await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[0]));await settle()
 holdChoice=true;await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.selected!));await settle()
 await chooseOwner()
 await act(async()=>heldChoices[0].resolve({main_name:'Late external owner',revision:9}));await settle()
 assert.equal(vm().detail.selection?.proposedOwner?.actressId,1001)
 assert.equal(vm().dialogs.otherOwner.selected,null)
 assert.equal(vm().dialogs.otherOwner.choosingId,null)
})


it('invalidates a pending external-owner choice when a decision is submitted',async()=>{
 staleResolution=true;await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[0]));await settle()
 holdChoice=true;await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.selected!));await settle()
 await act(async()=>vm().detail.confirmOwnership());await settle();await settle();await settle()
 await act(async()=>heldChoices[0].resolve({main_name:'Late after submit',revision:9}));await settle()
 assert.equal(vm().detail.selection?.proposedOwner,null)
 assert.ok(vm().queue.staleMessage)
 assert.equal(vm().dialogs.otherOwner.choosingId,null)
})

it('ignores a picker choice after navigating group A-B-A',async()=>{
 await mount();await act(async()=>vm().detail.openOtherOwner());await settle()
 holdChoice=true;await act(async()=>vm().dialogs.otherOwner.choose(vm().dialogs.otherOwner.options[0]));await settle()
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(2))})));await settle();await settle()
 await act(async()=>navigate(pendingCenterPath({type:'actress',item:pendingItemKey('actress',name(1))})));await settle();await settle()
 await act(async()=>heldChoices[0].resolve({main_name:'Old session',revision:9}));await settle()
 assert.equal(vm().dialogs.otherOwner.selected,null)
 assert.equal(vm().detail.selection?.proposedOwner,null)
 assert.equal(vm().dialogs.otherOwner.choosingId,null)
})
