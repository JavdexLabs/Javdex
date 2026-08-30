import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMainInvokeEvent } from 'electron'
import type { AppIpcContract } from '@shared/appIpcContract'
import { IPC, type IpcChannel } from '@shared/ipc-channels'
import type { LibraryScanLatestSnapshot } from '@shared/libraryTypes'
import { appIpcSchemas } from './ipcCommandSchemas'
import { registerScanLatestHandler } from './scanHandlers'
import { createTypedIpcAdapter } from './typedIpcAdapter'

describe('scan latest IPC handler', () => {
  it('validates libraryId and forwards the scoped latest snapshot', async () => {
    const registrations = new Map<
      IpcChannel,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
    >()
    const adapter = createTypedIpcAdapter<AppIpcContract>(
      appIpcSchemas,
      (channel, handler) => registrations.set(channel, handler)
    )
    const expected: LibraryScanLatestSnapshot = {
      summary: null,
      audit: null,
      unrecognized: [{ rootId: 8, filePath: '/media/UNKNOWN.mp4' }]
    }
    const calls: number[] = []
    registerScanLatestHandler(adapter, (libraryId) => {
      calls.push(libraryId)
      return expected
    })
    const handler = registrations.get(IPC.SCAN_LATEST_GET)
    assert.ok(handler)

    assert.deepEqual(await handler({} as IpcMainInvokeEvent, 3), expected)
    assert.deepEqual(calls, [3])
    assert.throws(() => handler({} as IpcMainInvokeEvent, 0), /无效的 IPC 请求参数/)
  })
})
