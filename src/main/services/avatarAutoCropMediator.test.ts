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
