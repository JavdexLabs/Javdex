import assert from 'node:assert/strict'
import {afterEach,it} from 'node:test'
import React from 'react'
import TestRenderer,{act} from 'react-test-renderer'
import type {ClassificationEntityRef,ClassificationImageInput,ClassificationListPage,ClassificationImageCandidate,ClassificationImageUpdateResult} from '@shared/classificationTypes'
let total=125,fail=false,cancelled=0,changed=0
let hold: (()=>Promise<ClassificationListPage<ClassificationImageCandidate>>) | null=null
let saveHold: (()=>Promise<ClassificationImageUpdateResult>) | null=null
const calls:Array<{entity:ClassificationEntityRef;offset:number}>=[],saves:Array<{entity:ClassificationEntityRef;input:ClassificationImageInput}>=[]
function page(offset:number){return{items:Array.from({length:Math.min(60,Math.max(0,total-offset))},(_,n)=>({videoId:offset+n+1,code:`CODE-${offset+n+1}`,title:null,coverPath:`covers/${offset+n+1}.jpg`})),total,limit:60,offset}}
Object.defineProperty(globalThis,'React',{configurable:true,value:React})
Object.defineProperty(globalThis,'window',{configurable:true,value:Object.assign(new EventTarget(),{api:{classificationImages:{
 candidates:()=>{throw Error('Full candidates forbidden')},
 page:async(entity:ClassificationEntityRef,q:{offset:number})=>{calls.push({entity,offset:q.offset});if(fail){fail=false;throw Error('Page failed')}if(hold){const run=hold;hold=null;return run()}return page(q.offset)},
 set:async(entity:ClassificationEntityRef,input:ClassificationImageInput)=>{saves.push({entity,input});return saveHold?saveHold():{imagePath:'saved.jpg',cleanupFailures:[]}}
}}})})
Object.defineProperty(globalThis,'document',{configurable:true,value:{body:{style:{overflow:''}},activeElement:null}})
let renderer:TestRenderer.ReactTestRenderer|undefined
let Component:typeof import('./ClassificationImageModal').default
let entity:ClassificationEntityRef={kind:'director',id:1}
function tree(){return <Component entity={entity} entityLabel="导演" imagePath={null} fallbackCoverPath={null} onCancel={()=>{cancelled++}} onChanged={()=>{changed++}}/>}
const text=(n:TestRenderer.ReactTestInstance):string=>n.children.map(v=>typeof v==='string'?v:text(v)).join('')
async function click(label:string){
 if(label==='下一页'||label==='上一页'){
  const scroll=renderer!.root.findAll(node=>typeof node.props.onScroll==='function')[0]
  assert.ok(scroll?.props.onScroll,label)
  await act(async()=>scroll.props.onScroll({
   currentTarget:{scrollLeft:label==='下一页'?9840:0,clientWidth:400,clientHeight:80,scrollWidth:10000}
  }))
  return
 }
 await act(async()=>{const b=renderer!.root.findAllByType('button').find(b=>b.props['aria-label']===label||text(b)===label)!;assert.ok(b,label);assert.ok(!b.props.disabled,label);b.props.onClick()})
}
const candidates=()=>renderer!.root.findAllByType('button').filter(b=>/^CODE-/.test(b.props['aria-label']??''))
async function mount(){Component=(await import('./ClassificationImageModal')).default;await act(async()=>{renderer=TestRenderer.create(tree())})}
afterEach(async()=>{await act(async()=>renderer?.unmount());renderer=undefined;total=125;fail=false;hold=null;saveHold=null;calls.length=0;saves.length=0;cancelled=0;changed=0;entity={kind:'director',id:1}})

it('loads only the video source and retains the chosen original across 60/60/5 and error retry',async()=>{
 await mount();assert.equal(calls.length,0)
 await click('图片链接');assert.equal(calls.length,0)
 await click('影片封面');assert.equal(candidates().length,60)
 await click('CODE-1');assert.ok(renderer!.root.findAllByType('img').some(n=>n.props.src==='media://covers/1.jpg'))
 assert.equal(candidates()[0].findByType('img').props.src,'media://covers/1.jpg?size=320')
 await click('下一页');assert.ok(candidates().some(n=>n.props['aria-label']==='CODE-61'))
 assert.ok(candidates().length<=180)
 fail=true;await click('下一页');assert.ok(renderer!.root.findAllByProps({role:'alert'}).some(n=>text(n).includes('关联封面加载失败')))
 assert.ok(candidates().some(n=>n.props['aria-label']==='CODE-61'))
 await click('重试');assert.ok(candidates().some(n=>n.props['aria-label']==='CODE-121'))
 assert.ok(candidates().length<=180)
 assert.ok(renderer!.root.findAllByType('img').some(n=>n.props.src==='media://covers/1.jpg'))
 await click('上一页');await click('上一页');assert.equal(candidates()[0].props['aria-pressed'],true)
 await click('保存主图');assert.deepEqual(saves,[{entity:{kind:'director',id:1},input:{source:'video-cover',videoId:1}}]);assert.equal(changed,1);assert.equal(cancelled,1)
})
it('clamps a shrunken last page and ignores a response after an entity switch',async()=>{
 await mount();await click('影片封面');await click('下一页');total=30;await click('下一页')
 assert.ok(candidates().length>0 && candidates().length<=30)
 total=125;let finish!:(p:ReturnType<typeof page>)=>void;hold=()=>new Promise(resolve=>{finish=resolve})
 entity={kind:'series',id:2};await act(async()=>renderer!.update(tree()))
 await click('影片封面');assert.equal(candidates().length,0)
 entity={kind:'director',id:3};await act(async()=>renderer!.update(tree()))
 await act(async()=>finish(page(0)));assert.equal(candidates().length,0)
 await click('影片封面');assert.equal(candidates().length,60);assert.deepEqual(calls.at(-1)!.entity,{kind:'director',id:3})
})
it('does not close or refresh a new entity editor when an old save settles',async()=>{
 await mount();await click('影片封面');await click('CODE-1')
 let finish!:(result:ClassificationImageUpdateResult)=>void;saveHold=()=>new Promise(resolve=>{finish=resolve})
 await click('保存主图');entity={kind:'series',id:2};await act(async()=>renderer!.update(tree()))
 await act(async()=>finish({imagePath:'saved.jpg',cleanupFailures:[]}));assert.equal(changed,0);assert.equal(cancelled,0)
 assert.ok(renderer!.root.findAllByType('button').find(b=>text(b)==='保存主图')!.props.disabled)
})


it('does not replace a chosen video cover with a late URL preview after switching sources',async()=>{
 let finish!:(value:{mimeType:string;dataBase64:string})=>void
 Object.assign(window.api,{assets:{fetchRemoteImagePreview:()=>new Promise(resolve=>{finish=resolve})}})
 await mount();await click('图片链接')
 await act(async()=>renderer!.root.findAllByType('input').find(n=>n.props.type==='url')!.props.onChange({target:{value:'https://example.test/image.jpg'}}))
 await click('加载并预览')
 await click('影片封面');await click('CODE-1')
 await act(async()=>finish({mimeType:'image/png',dataBase64:'AAAA'}))
 assert.ok(renderer!.root.findAllByType('img').some(n=>n.props.src==='media://covers/1.jpg'))
 await click('保存主图');assert.deepEqual(saves[0].input,{source:'video-cover',videoId:1})
})
