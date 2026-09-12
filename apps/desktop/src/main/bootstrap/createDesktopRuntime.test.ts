import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { createDesktopRuntime, workStorePath } from './createDesktopRuntime'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../desktop/thisComputerSettingsStore'
import { openDesktopWorkStore } from '../desktop/workStore'

let tempRoot: string | null = null

function tempDir(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s02d-bootstrap-'))
  return tempRoot
}

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('createDesktopRuntime', () => {
  it('starts local mode with a catalog identity and does not require a prior workStore copy', async () => {
    const root = tempDir()
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.mode, 'local')
      assert.equal(runtime.backend.mode, 'local')
      assert.equal(runtime.backend.session().serverId, null)
      assert.equal(runtime.workStore.prepStatus(), 'idle')
    } finally {
      await runtime.dispose()
    }
  })

  it('starts unconfigured remote without opening library.db', async () => {
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'https://library.example' })
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.mode, 'remote')
      assert.equal(runtime.backend.session().state, 'disconnected')
      await assert.rejects(
        () => runtime.backend.queries.listVideos({ scope: { kind: 'all' } }),
        (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
      )
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await runtime.dispose()
    }
  })

  it('refuses remote start while workStore copy is unfinished', async () => {
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'https://library.example' })
    const store = openDesktopWorkStore(workStorePath(root))
    store.beginCopy()
    store.close()
    await assert.rejects(
      () => createDesktopRuntime(root, '0.7.0'),
      (error: unknown) => isStructuredError(error) && error.code === 'MODE_PREP_REQUIRED'
    )
    assert.throws(() => getDb(), /Database not initialised/)
  })
})
