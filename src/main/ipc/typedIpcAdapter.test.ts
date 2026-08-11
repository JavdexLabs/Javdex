import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { createTypedEventAdapter, createTypedIpcAdapter } from './typedIpcAdapter'
import { executeIpcHandler } from './shared'
import { videoIpcSchemas } from './ipcCommandSchemas'
import type { IpcMainInvokeEvent } from 'electron'

describe('typed IPC adapter', () => {
  it('forwards command arguments and returns the application result', async () => {
    let registered: ((id: number, rating: number) => unknown | Promise<unknown>) | null = null
    const adapter = createTypedIpcAdapter<VideoIpcContract>(
      videoIpcSchemas,
      (channel, handler) => {
        assert.equal(channel, IPC.VIDEO_SET_RATING)
        registered = (id: number, rating: number) =>
          handler({} as IpcMainInvokeEvent, id, rating)
      }
    )
    adapter.register(IPC.VIDEO_SET_RATING, (id, rating) => id === 7 && rating === 4)

    assert.equal(
      await (registered as ((id: number, rating: number) => unknown | Promise<unknown>) | null)?.(7, 4),
      true
    )
  })

  it('rejects malformed arguments before invoking the application handler', async () => {
    let registered: ((...args: unknown[]) => unknown | Promise<unknown>) | null = null
    let invoked = false
    const adapter = createTypedIpcAdapter<VideoIpcContract>(
      videoIpcSchemas,
      (_channel, handler) => {
        registered = (...args: unknown[]) => handler({} as IpcMainInvokeEvent, ...args)
      }
    )
    adapter.register(IPC.VIDEO_SET_RATING, () => {
      invoked = true
      return true
    })

    assert.throws(
      () => {
        void (registered as ((...args: unknown[]) => unknown | Promise<unknown>))(7, 9)
      },
      /无效的 IPC 请求参数/
    )
    assert.equal(invoked, false)
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
