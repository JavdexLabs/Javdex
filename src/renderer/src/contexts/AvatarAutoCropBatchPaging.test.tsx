import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ElectronApi } from '../../../preload/index'
import type { ActressAvatarCropTargetPage } from '@shared/actressAvatarCropTypes'
function deferred<T>() {
  let resolve!: (value:T)=>void, reject!: (error:Error)=>void
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no})
  return {promise,resolve,reject}
}

it('consumes pages on demand and stops safely across page failure, cancellation and unmount', async () => {
  const items=Array.from({length:230},(_,i)=>({actressId:i+1,mainName:`Actor-${i+1}`}))
  const page=(afterId:number):ActressAvatarCropTargetPage=>({items:items.slice(afterId,afterId+100),total:230,nextAfterId:afterId+100<230?afterId+100:null})
  let mode='normal',tokenId=0
  let held=deferred<ActressAvatarCropTargetPage>()
  let calls:number[]=[],processed:number[]=[],ended:string[]=[]
  const fake={
    actresses:{avatarCropTargets:()=>{throw new Error('Full targets forbidden')},list:()=>{throw new Error('Wide list forbidden')},getAvatarSourceInfo:async(id:number)=>{processed.push(id);return null}},
    settings:{get:async()=>({})},
    actressScrape:{onAvatarAutoCropRequest:()=>()=>{}},
    avatarAutoCropBatch:{begin:async()=>String(++tokenId),end:async(token:string)=>{ended.push(token);return true},targets:async(_token:string,afterId:number)=>{
      calls.push(afterId)
      if(afterId===100&&mode==='failure')throw new Error('Page failed')
      if(afterId===100&&mode!=='normal')return held.promise
      return page(afterId)
    }}
  } as unknown as ElectronApi
  Object.defineProperty(globalThis,'React',{configurable:true,value:React})
  Object.defineProperty(globalThis,'window',{configurable:true,value:{api:fake}})
  const {AvatarAutoCropBatchProvider,useAvatarAutoCropBatch}=await import('./AvatarAutoCropBatchContext')
  let current!:ReturnType<typeof useAvatarAutoCropBatch>
  function Probe(){current=useAvatarAutoCropBatch();return null}
  const client=new QueryClient()
  let renderer!:TestRenderer.ReactTestRenderer
  const settle=async()=>{await act(async()=>{await new Promise(resolve=>setImmediate(resolve))})}
  const mount=async()=>{calls=[];processed=[];ended=[];held=deferred();await act(async()=>{renderer=TestRenderer.create(<QueryClientProvider client={client}><AvatarAutoCropBatchProvider><Probe/></AvatarAutoCropBatchProvider></QueryClientProvider>)})}
  const unmount=async()=>{await act(async()=>renderer.unmount())}
  const start=async()=>{await act(async()=>{assert.equal(await current.startAllAvatars(),230);await new Promise(resolve=>setImmediate(resolve))})}
  try {
    await mount();await start()
    assert.deepEqual(calls,[0,100,200]);assert.deepEqual(processed,items.map(item=>item.actressId))
    assert.equal(current.state.current,230);assert.equal(current.state.skipped,230)
    assert.equal(current.state.logs.length,200);assert.deepEqual(ended,['1'])
    await unmount();mode='failure';await mount();await start()
    assert.deepEqual(calls,[0,100]);assert.equal(processed.length,100)
    assert.equal(current.state.current,230);assert.equal(current.state.failed,130)
    assert.ok(current.state.logs.some(log=>log.message.includes('130 项未处理')))
    assert.deepEqual(ended,['2'])
    await unmount()
    for(const action of ['cancel','unmount','cancel-reject']) {
      mode=action;await mount();await start()
      assert.deepEqual(calls,[0,100]);assert.equal(processed.length,100)
      assert.equal(ended.length,0,'page in flight retains token')
      if(action==='unmount')await unmount();else await act(async()=>current.cancel())
      assert.equal(ended.length,0)
      if(action==='cancel-reject')held.reject(new Error('Late page error'));else held.resolve(page(100))
      await settle()
      assert.deepEqual(calls,[0,100]);assert.equal(processed.length,100)
      assert.equal(ended.length,1)
      if(action!=='unmount'){
        assert.equal(current.state.current,100);assert.equal(current.state.failed,0)
        assert.equal(current.state.cancelled,true);await unmount()
      }
    }
  }finally{await unmount();client.clear()}
})
