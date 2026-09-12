import { it } from 'node:test'
import assert from 'node:assert/strict'
import { appendAvatarLog, avatarLogNotice, type AvatarLogState } from './logs'
it('keeps only recent log previews after 100000 entries while counting omissions', () => {
  let state: AvatarLogState = {logs:[],totalLogCount:0,shortenedLogCount:0}
  for (let i=0;i<100000;i++) state=appendAvatarLog(state,{time:'now',code:String(i),message:'result',level:'info'})
  assert.equal(state.totalLogCount,100000)
  assert.equal(state.logs.length,200)
  assert.equal(state.logs[0].code,'99800')
  assert.equal(state.logs[199].code,'99999')
  assert.match(avatarLogNotice(state),/99800 条较早日志/)
})
it('bounds oversized fields without splitting surrogate pairs or mutating prior state', () => {
  const original: AvatarLogState = {logs:[],totalLogCount:0,shortenedLogCount:0}
  const entry={time:'t'.repeat(10000),code:'😀'.repeat(10000),message:'\u0000'.repeat(20000),level:'error' as const}
  const state=appendAvatarLog(original,entry)
  assert.equal(original.logs.length,0)
  assert.equal(entry.code.length,20000)
  assert.equal(state.logs[0].time.length,64)
  assert.ok(state.logs[0].code.length<=128)
  assert.equal(state.logs[0].code.slice(-3),'😀…')
  assert.equal(state.logs[0].message.length,1024)
  assert.equal(state.shortenedLogCount,1)
  assert.match(avatarLogNotice(state),/1 条日志的长文本已截断/)
})
