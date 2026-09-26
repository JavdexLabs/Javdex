import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, it } from 'node:test'
import { IPC } from '@shared/ipc-channels'
import type { AppIpcContract } from '@shared/appIpcContract'
import type { IpcChannel } from '@shared/ipc-channels'
import { isStructuredError } from '@shared/protocol/errors'
import type { IpcMainInvokeEvent } from 'electron'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { appIpcSchemas } from './ipcCommandSchemas'
import { probeRemoteConnection, registerDesktopSessionHandlers } from './desktopSessionHandlers'
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
  it('broadcasts backend authentication changes without waiting for a settings request', () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-session-events-'))
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(tempRoot))
    const backend = createUnconfiguredRemoteBackend({ state: 'authInvalid' })
    let notify!: () => void
    backend.onSessionChanged = listener => { notify = listener; return () => undefined }
    const sent: unknown[][] = []
    const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, () => undefined)
    registerDesktopSessionHandlers({ getWindow: () => ({ webContents: { send: (...args: unknown[]) => sent.push(args) } }) as never }, { backend, settings }, adapter)
    notify()
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], IPC.DESKTOP_SESSION_CHANGED)
    assert.equal((sent[0][1] as { session: { state: string } }).session.state, 'authInvalid')
  })
  it('tests an unsaved server address with a public handshake and classifies first authorization', async () => {
    let ready = 'ready'
    let writerEpoch = 1
    let appVersion = '0.8.0-beta.1'
    const server = createServer((request, response) => {
      assert.equal(request.url, '/manage/v1/handshake.get')
      assert.equal(request.headers.authorization, undefined)
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        appVersion, identity: { serverId: 'server-1', catalogId: 'catalog-1' },
        writerEpoch, ready
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const url = `http://127.0.0.1:${address.port}`
      const reachable = await probeRemoteConnection(url, '0.8.0-beta.1')
      assert.equal(reachable.status, 'reachable')
      assert.equal(reachable.catalogId, 'catalog-1')

      ready = 'notBound'
      writerEpoch = 0
      assert.equal((await probeRemoteConnection(url, '0.8.0-beta.1')).status, 'notBound')
      appVersion = '0.8.0-beta.2'
      assert.equal((await probeRemoteConnection(url, '0.8.0-beta.1')).status, 'versionMismatch')
      await assert.rejects(() => probeRemoteConnection('javascript:alert(1)', '0.8.0-beta.1'))
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('picks a local player without saving settings and leaves the draft unchanged on cancel', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-player-picker-'))
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(tempRoot))
    const backend = createUnconfiguredRemoteBackend()
    const handlers = new Map<IpcChannel, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
    const adapter = createTypedIpcAdapter<AppIpcContract>(appIpcSchemas, (channel, handler) =>
      handlers.set(channel, handler)
    )
    const seen: Array<string | null> = []
    registerDesktopSessionHandlers(
      { getWindow: () => null },
      { backend, settings },
      adapter,
      async (currentPath) => {
        seen.push(currentPath)
        return currentPath ? '/usr/bin/mpv' : null
      }
    )

    const pick = handlers.get(IPC.THIS_COMPUTER_PICK_PLAYER)!
    assert.equal(await pick({} as IpcMainInvokeEvent, '/previous/player'), '/usr/bin/mpv')
    assert.equal(await pick({} as IpcMainInvokeEvent, null), null)
    assert.deepEqual(seen, ['/previous/player', null])
    assert.equal((await settings.read()).playerPath, null)
    assert.throws(
      () => pick({} as IpcMainInvokeEvent, 'x'.repeat(4097)),
      (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT'
    )
  })

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
