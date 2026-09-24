import { it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import BatchSettingsPanel from './BatchSettingsPanel'
import { appendAvatarLog, avatarLogNotice, type AvatarLogState } from '../../avatarAutoCrop/logs'
it('shows bounded log preview with explicit omission notice and full task counters', async () => {
  Object.defineProperty(globalThis,'React',{configurable:true,value:React})
  let state: AvatarLogState = {logs:[],totalLogCount:0,shortenedLogCount:0}
  for(let i=0;i<500;i++) state=appendAvatarLog(state,{time:new Date(0).toISOString(),code:String(i),message:'Skipped',level:'info'})
  let renderer!:TestRenderer.ReactTestRenderer
  try {
    await act(async()=>{renderer=TestRenderer.create(<BatchSettingsPanel scope="avatar" batch={{total:500,current:500,success:0,failed:0,pending:0,currentCode:null,status:'done',logs:state.logs}} running={false} paused={false} skipped={500} logRef={{current:null}} emptyLog="Empty" logNotice={avatarLogNotice(state)} onPause={()=>{}} onResume={()=>{}} onDiscard={()=>{}} />)})
    const rows=renderer.root.findAll(node=>typeof node.props.className==='string'&&node.props.className.startsWith('log-line '))
    assert.equal(rows.length,200)
    const output=JSON.stringify(renderer.toJSON())
    assert.match(output,/已省略 300 条较早日志/)
    assert.match(output,/500\/500/)
    assert.doesNotMatch(output,/\[00:00:00\] 0 /)
  } finally {await act(async()=>renderer?.unmount())}
})
