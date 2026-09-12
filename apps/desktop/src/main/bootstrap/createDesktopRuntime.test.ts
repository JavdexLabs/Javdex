import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { configureAgentWorkTablePrefix } from '@library/runtime/host'
import { isStructuredError } from '@shared/protocol/errors'
import { resetAgentRunDatabaseForTests } from '../agent-platform/agentRunStore'
import {
  createDesktopRuntime,
  localCatalogDatabasePath,
  workStorePath
} from './createDesktopRuntime'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../desktop/thisComputerSettingsStore'
import { openDesktopWorkStore } from '../desktop/workStore'

let tempRoot: string | null = null
let handshakeServer: Server | null = null

function tempDir(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s02d-bootstrap-'))
  return tempRoot
}

function insertAgentRun(database: ReturnType<typeof getDb>, id: string): void {
  database
    .prepare(
      `INSERT INTO agent_runs (
         id, use_case, status, config_revision, config_snapshot_json, runtime_id,
         product_state_json, created_at, updated_at
       ) VALUES (?, 'plugin-developer', 'closed', 'test', '{}', 'pi', '{}', 'old', 'old')`
    )
    .run(id)
}

afterEach(async () => {
  configureAgentWorkTablePrefix('')
  resetAgentRunDatabaseForTests()
  closeDatabase()
  if (handshakeServer) {
    await new Promise<void>((resolve, reject) =>
      handshakeServer!.close((error) => (error ? reject(error) : resolve()))
    )
    handshakeServer = null
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

function listenHandshake(appVersion: string, writerEpoch = 1): Promise<string> {
  handshakeServer = createHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        protocolVersion: 1,
        appVersion,
        schemaVersion: 18,
        identity: { serverId: 'server-1', catalogId: 'catalog-1' },
        writerEpoch,
        ready: writerEpoch > 0 ? 'ready' : 'notBound',
        capabilities: {
          encryptedAssets: false,
          transcoding: false,
          arbitraryUrlProxy: false,
          pluginExecution: false,
          publicInternetDefault: false,
          writerBound: writerEpoch > 0,
          browserEnabled: true,
          managementEnabled: true
        }
      })
    )
  })
  return new Promise((resolve, reject) => {
    handshakeServer!.listen(0, '127.0.0.1', () => {
      const address = handshakeServer!.address()
      if (!address || typeof address === 'string') {
        reject(new Error('port'))
        return
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

describe('createDesktopRuntime', () => {
  it('starts local mode, copies agent work, and marks workStore ready', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
    insertAgentRun(catalog, 'run-source')
    closeDatabase()

    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.mode, 'local')
      assert.equal(runtime.backend.mode, 'local')
      assert.equal(runtime.openedCatalog, true)
      assert.equal(runtime.backend.session().serverId, null)
      assert.equal(runtime.workStore.prepStatus(), 'ready')
      assert.equal(
        (runtime.workStore.database().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS n FROM main.agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS n FROM work.agent_runs').get() as { n: number }).n,
        1
      )
      insertAgentRun(getDb(), 'run-after-switch')
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS n FROM main.agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (getDb().prepare("SELECT id FROM work.agent_runs ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id
        ).join(','),
        'run-after-switch,run-source'
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('resumes an interrupted agent work copy without deleting source rows', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
    insertAgentRun(catalog, 'run-interrupted')
    closeDatabase()
    const store = openDesktopWorkStore(workStorePath(root))
    store.beginCopy()
    store.close()

    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.workStore.prepStatus(), 'ready')
      assert.equal(
        (getDb().prepare("SELECT id FROM main.agent_runs").get() as { id: string }).id,
        'run-interrupted'
      )
      assert.equal(
        (getDb().prepare("SELECT id FROM work.agent_runs").get() as { id: string }).id,
        'run-interrupted'
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('starts unconfigured remote without opening library.db', async () => {
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.mode, 'remote')
      assert.equal(runtime.openedCatalog, false)
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

  it('starts remote in modePrepRequired when workStore copy is unfinished', async () => {
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const store = openDesktopWorkStore(workStorePath(root))
    store.beginCopy()
    store.close()
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.mode, 'remote')
      assert.equal(runtime.openedCatalog, false)
      assert.equal(runtime.backend.session().state, 'modePrepRequired')
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await runtime.dispose()
    }
  })

  it('starts remote in modePrepRequired when a local catalog exists and workStore is not ready', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(localCatalogDatabasePath(root), '')
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.backend.session().state, 'modePrepRequired')
      assert.equal(runtime.openedCatalog, false)
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await runtime.dispose()
    }
  })

  it('starts remote versionMismatch without opening library.db', async () => {
    const base = await listenHandshake('9.9.9-other')
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: base })
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.openedCatalog, false)
      assert.equal(runtime.backend.session().state, 'versionMismatch')
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await runtime.dispose()
    }
  })

  it('starts remote recoveryRequired when the catalog is bound but this computer has no writer secret', async () => {
    const base = await listenHandshake('0.7.0', 1)
    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: base })
    const runtime = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(runtime.openedCatalog, false)
      assert.equal(runtime.backend.session().state, 'recoveryRequired')
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await runtime.dispose()
    }
  })

  it('starts remote after a completed local copy without reopening library.db', async () => {
    const root = tempDir()
    const local = await createDesktopRuntime(root, '0.7.0')
    assert.equal(local.workStore.prepStatus(), 'ready')
    await local.dispose()
    assert.throws(() => getDb(), /Database not initialised/)

    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const remote = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(remote.mode, 'remote')
      assert.equal(remote.openedCatalog, false)
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await remote.dispose()
    }
  })

  it('reopens the original local catalog after switching back from remote', async () => {
    const root = tempDir()
    const local = await createDesktopRuntime(root, '0.7.0')
    getDb().prepare("INSERT INTO actresses (main_name) VALUES ('Keep Local')").run()
    await local.dispose()

    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const remote = await createDesktopRuntime(root, '0.7.0')
    assert.equal(remote.openedCatalog, false)
    assert.throws(() => getDb(), /Database not initialised/)
    await remote.dispose()

    await settings.write({ mode: 'local', remoteBaseUrl: null })
    const back = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(back.mode, 'local')
      assert.equal(back.openedCatalog, true)
      assert.equal(
        (getDb().prepare("SELECT main_name FROM actresses WHERE main_name = 'Keep Local'").get() as { main_name: string })
          .main_name,
        'Keep Local'
      )
    } finally {
      await back.dispose()
    }
  })
})
