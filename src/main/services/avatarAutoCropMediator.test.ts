import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AvatarAutoCropMediator,
  type AvatarAutoCropMediatorDependencies
} from './avatarAutoCropMediator'

function dependencies(
  overrides: Partial<AvatarAutoCropMediatorDependencies> = {}
): AvatarAutoCropMediatorDependencies {
  return {
    emit: () => undefined,
    rendererAvailable: () => true,
    randomId: () => 'request-1',
    autoCropTimeoutMs: 10,
    assertCanBeginBatch: () => undefined,
    ...overrides
  }
}

describe('AvatarAutoCropMediator', () => {
  it('resolves automatic crop requests and rejects stale replies', async () => {
    let requestId = ''
    const mediator = new AvatarAutoCropMediator(
      dependencies({
        emit: (_channel, payload) => {
          requestId = (payload as { requestId: string }).requestId
        }
      })
    )
    const pending = mediator.request({ actressId: 1, mainName: 'Test' })

    assert.equal(mediator.complete({ requestId, status: 'success' }), true)
    assert.deepEqual(await pending, { status: 'success', message: undefined })
    assert.equal(mediator.complete({ requestId, status: 'success' }), false)
  })

  it('fails pending automatic crop requests after renderer disconnects', async () => {
    const mediator = new AvatarAutoCropMediator(dependencies())
    const pending = mediator.request({ actressId: 1, mainName: 'Test' })

    mediator.rendererDisconnected()

    assert.deepEqual(await pending, { status: 'failed', message: '应用窗口不可用' })
    assert.equal(mediator.hasActiveBatch(), false)
  })

  it('times out automatic crop requests without accepting a late response', async () => {
    const mediator = new AvatarAutoCropMediator(dependencies({ autoCropTimeoutMs: 1 }))

    assert.deepEqual(await mediator.request({ actressId: 1, mainName: 'Test' }), {
      status: 'failed',
      message: '智能构图等待超时'
    })
    assert.equal(mediator.complete({ requestId: 'request-1', status: 'success' }), false)
  })

  it('owns the crop batch token until matching end or disconnect', () => {
    const mediator = new AvatarAutoCropMediator(dependencies({ randomId: () => 'token-1' }))
    const token = mediator.beginBatch()

    assert.equal(token, 'token-1')
    assert.equal(mediator.hasActiveBatch(), true)
    assert.equal(mediator.endBatch('wrong'), false)
    assert.equal(mediator.hasActiveBatch(), true)
    assert.equal(mediator.endBatch('token-1'), true)
    assert.equal(mediator.hasActiveBatch(), false)
  })

  it('rejects a second begin while a crop batch is active', () => {
    const mediator = new AvatarAutoCropMediator(dependencies())
    mediator.beginBatch()
    assert.throws(() => mediator.beginBatch(), /批量智能构图正在进行中/)
  })
})


it('creates one lazy snapshot per batch and disposes only its owning token', () => {
  let created=0,disposed=0,sequence=0
  const cursors:number[]=[]
  const mediator=new AvatarAutoCropMediator(dependencies({
    randomId:()=>`token-${++sequence}`,
    createBatchTargets:()=>{created++;return {page:(afterId)=>{cursors.push(afterId);return {items:[],total:20,nextAfterId:null}},dispose:()=>{disposed++}}}
  }))
  const first=mediator.beginBatch()
  assert.equal(created,0)
  assert.throws(()=>mediator.pageBatchTargets('wrong',0),/令牌/)
  assert.throws(()=>mediator.pageBatchTargets(first,-1),/游标/)
  assert.equal(created,0)
  assert.equal(mediator.pageBatchTargets(first,0).total,20)
  mediator.pageBatchTargets(first,100)
  assert.equal(created,1);assert.deepEqual(cursors,[0,100])
  assert.equal(mediator.endBatch('wrong'),false);assert.equal(disposed,0)
  assert.equal(mediator.endBatch(first),true);assert.equal(disposed,1)
  assert.throws(()=>mediator.pageBatchTargets(first,0),/令牌/)
  const second=mediator.beginBatch();mediator.pageBatchTargets(second,0)
  assert.equal(mediator.endBatch(first),false)
  mediator.rendererDisconnected();assert.equal(disposed,2)
  assert.throws(()=>mediator.pageBatchTargets(second,0),/令牌/)
})
it('retries failed snapshot creation without poisoning the batch and clears on reinitialization', () => {
  let attempts=0,disposed=0
  const mediator=new AvatarAutoCropMediator(dependencies({createBatchTargets:()=>{
    if(++attempts===1)throw new Error('Snapshot failed')
    return {page:()=>({items:[],total:0,nextAfterId:null}),dispose:()=>{disposed++}}
  }}))
  const token=mediator.beginBatch()
  assert.throws(()=>mediator.pageBatchTargets(token,0),/Snapshot failed/)
  assert.equal(mediator.hasActiveBatch(),true)
  assert.equal(mediator.pageBatchTargets(token,0).total,0)
  mediator.clearBatchToken();mediator.clearBatchToken()
  assert.equal(disposed,1);assert.equal(mediator.hasActiveBatch(),false)
})


it('settles disconnected requests despite cleanup failure and retries before allowing another snapshot', async () => {
  let fail=true,created=0,disposed=0,id=0
  const mediator=new AvatarAutoCropMediator(dependencies({randomId:()=>String(++id),createBatchTargets:()=>{
    created++;return {page:()=>({items:[],total:0,nextAfterId:null}),dispose:()=>{disposed++;if(fail)throw new Error('Drop failed')}}
  }}))
  const token=mediator.beginBatch();mediator.pageBatchTargets(token,0)
  const pending=mediator.request({actressId:1,mainName:'Waiting'})
  const warn=console.warn;console.warn=()=>{}
  try {mediator.rendererDisconnected()} finally {console.warn=warn}
  assert.equal((await pending).status,'failed')
  assert.equal(mediator.hasActiveBatch(),false)
  assert.throws(()=>mediator.pageBatchTargets(token,0),/令牌/)
  assert.throws(()=>mediator.beginBatch(),/Drop failed/)
  assert.equal(created,1)
  fail=false
  const next=mediator.beginBatch();mediator.pageBatchTargets(next,0)
  assert.equal(created,2)
  fail=true;console.warn=()=>{}
  try {assert.equal(mediator.endBatch(next),true)} finally {console.warn=warn}
  assert.equal(mediator.hasActiveBatch(),false)
  fail=false;mediator.clearBatchToken()
  assert.ok(disposed>=5)
})
