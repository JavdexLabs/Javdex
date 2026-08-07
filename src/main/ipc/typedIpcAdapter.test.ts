import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { executeIpcHandler } from './shared'

describe('typed IPC adapter', () => {
  it('forwards command arguments and returns the application result', async () => {
    let registered: ((id: number, rating: number) => boolean) | null = null
    const adapter = createTypedIpcAdapter<VideoIpcContract>((channel, handler) => {
      assert.equal(channel, IPC.VIDEO_SET_RATING)
      registered = handler as unknown as (id: number, rating: number) => boolean
    })
    adapter.register(IPC.VIDEO_SET_RATING, (id, rating) => id === 7 && rating === 4)

    assert.equal((registered as ((id: number, rating: number) => boolean) | null)?.(7, 4), true)
  })

  it('serializes successful results and thrown errors', async () => {
    assert.deepEqual(await executeIpcHandler((value: number) => value * 2, [3]), {
      ok: true,
      data: 6
    })
    assert.deepEqual(
      await executeIpcHandler(() => {
        throw new Error('broken')
      }, []),
      { ok: false, error: 'broken' }
    )
  })

  it('sends the contracted event payload unchanged', () => {
    interface TestEvents {
      [IPC.SCRAPE_BATCH_PROGRESS]: { current: number }
    }
    const sent: unknown[][] = []
    createTypedEventAdapter<TestEvents>().send(
      { send: (...args: unknown[]) => sent.push(args) },
      IPC.SCRAPE_BATCH_PROGRESS,
      { current: 3 }
    )

    assert.deepEqual(sent, [[IPC.SCRAPE_BATCH_PROGRESS, { current: 3 }]])
  })
})
