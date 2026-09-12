import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createThisComputerSettingsStore,
  thisComputerSettingsPath
} from './thisComputerSettingsStore'
import { loadOrCreateLocalCatalogIdentity, localCatalogIdentityPath } from './localCatalogIdentity'
import { openDesktopWorkStore } from './workStore'

let tempRoot: string | null = null

function tempDir(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s02d-desktop-'))
  return tempRoot
}

afterEach(() => {
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

describe('this-computer settings store', () => {
  it('defaults to local mode and persists a remote URL only for remote mode', async () => {
    const store = createThisComputerSettingsStore(thisComputerSettingsPath(tempDir()))
    assert.equal((await store.read()).mode, 'local')
    const remote = await store.write({
      mode: 'remote',
      remoteBaseUrl: ' https://library.example:8443 '
    })
    assert.equal(remote.mode, 'remote')
    assert.equal(remote.remoteBaseUrl, 'https://library.example:8443')
    const local = await store.write({ mode: 'local' })
    assert.equal(local.mode, 'local')
    assert.equal(local.remoteBaseUrl, null)
  })
})

describe('local catalog identity', () => {
  it('is stable per user-data directory and is not a filesystem path', () => {
    const root = tempDir()
    const file = localCatalogIdentityPath(root)
    const first = loadOrCreateLocalCatalogIdentity(file)
    const second = loadOrCreateLocalCatalogIdentity(file)
    assert.equal(first.mode, 'local')
    assert.equal(first.catalogId, second.catalogId)
    assert.equal(first.catalogId.includes(path.sep), false)
    assert.notEqual(first.catalogId, root)
  })
})

describe('desktop workStore', () => {
  it('stores tasks and keeps copy-prep from becoming ready until marked', async () => {
    const store = openDesktopWorkStore(path.join(tempDir(), 'work.db'))
    try {
      assert.equal(store.prepStatus(), 'idle')
      store.beginCopy()
      assert.equal(store.prepStatus(), 'copying')
      await store.putTask({
        owner: 'desktop',
        taskId: 'task-1',
        catalogId: 'catalog-1',
        kind: 'scan',
        state: 'running',
        taskRevision: 1,
        progressSeq: 0
      })
      assert.equal((await store.getTask('task-1'))?.state, 'running')
      store.putVerification('op-1', 'catalog-1')
      assert.deepEqual(await store.listOpenVerifications(), [
        { operationId: 'op-1', catalogId: 'catalog-1' }
      ])
      store.markReady()
      store.beginCopy()
      assert.equal(store.prepStatus(), 'ready')
    } finally {
      store.close()
    }
  })

  it('reopens copying state after a crash before the ready marker', () => {
    const file = path.join(tempDir(), 'work.db')
    const first = openDesktopWorkStore(file)
    first.beginCopy()
    first.close()
    const second = openDesktopWorkStore(file)
    try {
      assert.equal(second.prepStatus(), 'copying')
    } finally {
      second.close()
    }
  })
})
