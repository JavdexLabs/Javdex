import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { CatalogBackend } from '../application/catalogBackend'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import type { IpcContext } from '../ipc/shared'
import type { ServerEnvironmentSnapshot } from '@shared/serverEnvironment'
import { createServerUpdateService } from './serverUpdateService'

test('desktop upgrade commands check the actual image before pairing, file selection or update RPC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-environment-service-'))
  const before = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  try {
    let session: { mode: 'remote'; remoteBaseUrl: string; appVersion?: string; desktopAppVersion: string } = {
      mode: 'remote', remoteBaseUrl: 'https://nas.example', appVersion: '0.8.0', desktopAppVersion: '0.9.0-beta.5'
    }
    const backend = { session: () => session } as unknown as CatalogBackend
    let environment: ServerEnvironmentSnapshot = { state: 'imageRequired', currentVersion: null, requiredVersion: 1, runtimeId: null, platform: null, message: '需要升级服务端Docker镜像' }
    const control = createServerUpdateService(backend, { getWindow: () => { assert.fail('must not open file selection') } }, {} as DesktopSettingsStore,
      { queryEnvironment: async () => environment })
    assert.equal((await control({ action: 'environment' })).environment?.state, 'imageRequired')
    for (const action of ['check', 'import', 'prepare', 'install'] as const) {
      await assert.rejects(control({ action, targetVersion: '0.9.0-beta.5', ...(action === 'install' ? { jobId: '33333333-3333-4333-8333-333333333333' } : {}) } as Parameters<typeof control>[0]), /需要升级服务端Docker镜像/)
    }
    environment = { ...environment, state: 'unavailable', message: '无法确认服务端运行环境' }
    await assert.rejects(control({ action: 'import', targetVersion: '0.9.0-beta.5' }), /无法确认/)
    environment = { ...environment, state: 'compatible', currentVersion: 1, message: null }
    await assert.rejects(control({ action: 'check', targetVersion: '0.9.0-beta.5' }), /配对/, 'environment compatibility cannot grant update authorization')
    session = { ...session, appVersion: undefined }
    environment = { ...environment, state: 'imageRequired', currentVersion: null }
    assert.equal((await control({ action: 'environment' })).environment?.state, 'unavailable', 'an unknown address returning 404 is not confirmed as an old Javdex image')
    environment = { ...environment, state: 'compatible', currentVersion: 1 }
    assert.equal((await control({ action: 'environment' })).environment?.state, 'compatible', 'the real metadata endpoint does not require a business handshake')
    let finish!: (value: ServerEnvironmentSnapshot) => void
    const moving = createServerUpdateService(backend, {} as IpcContext, {} as DesktopSettingsStore,
      { queryEnvironment: () => new Promise(resolve => { finish = resolve }) })
    const pending = moving({ action: 'environment' })
    session = { ...session, remoteBaseUrl: 'https://other.example' }
    finish(environment)
    assert.equal((await pending).environment?.state, 'unavailable', 'a response from the previous origin cannot enable the new target')
  } finally {
    if (before === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = before
    fs.rmSync(root, { recursive: true, force: true })
  }
})
