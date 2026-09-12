import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import type { AppIpcContract } from '@shared/appIpcContract'
import type { IpcChannel } from '@shared/ipc-channels'
import { isStructuredError } from '@shared/protocol/errors'
import type { IpcMainInvokeEvent } from 'electron'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { appIpcSchemas } from './ipcCommandSchemas'
import { registerDesktopSessionHandlers } from './desktopSessionHandlers'
import { createUnconfiguredRemoteBackend } from '../backends/remote/unconfiguredRemoteBackend'
import {
  createThisComputerSettingsStore,
  thisComputerSettingsPath
} from '../desktop/thisComputerSettingsStore'

let tempRoot: string | null = null

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('desktop session IPC', () => {
  it('rejects remote mode without a safe HTTP URL and does not leak a writer secret', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-session-ipc-'))
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(tempRoot))
    const backend = createUnconfiguredRemoteBackend()
    const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) =>
      handlers.set(channel, handler)
    )
    registerDesktopSessionHandlers({ getWindow: () => null }, { backend, settings }, adapter)

    const snapshot = await handlers.get(IPC.DESKTOP_SESSION_GET)!({} as IpcMainInvokeEvent)
    assert.equal((snapshot as { session: { state: string } }).session.state, 'disconnected')
    assert.equal(JSON.stringify(snapshot).toLowerCase().includes('secret'), false)

    await assert.rejects(
      async () => handlers.get(IPC.THIS_COMPUTER_UPDATE)!({} as IpcMainInvokeEvent, { mode: 'remote' }),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    await assert.rejects(
      async () =>
        handlers.get(IPC.THIS_COMPUTER_UPDATE)!({} as IpcMainInvokeEvent, {
          mode: 'remote',
          remoteBaseUrl: 'javascript:alert(1)'
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
    await assert.rejects(
      async () =>
        handlers.get(IPC.THIS_COMPUTER_UPDATE)!({} as IpcMainInvokeEvent, {
          mode: 'remote',
          remoteBaseUrl: 'http://user:token@127.0.0.1:8096'
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )

    const updated = (await handlers.get(IPC.THIS_COMPUTER_UPDATE)!({} as IpcMainInvokeEvent, {
      mode: 'remote',
      remoteBaseUrl: 'http://127.0.0.1:8096'
    })) as { restartRequired: boolean; settings: { mode: string } }
    assert.equal(updated.restartRequired, true)
    assert.equal(updated.settings.mode, 'remote')
    const stored = JSON.parse(fs.readFileSync(thisComputerSettingsPath(tempRoot), 'utf8')) as {
      remoteBaseUrl: string
    }
    assert.equal(stored.remoteBaseUrl, 'http://127.0.0.1:8096')
  })
})
