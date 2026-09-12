import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
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

afterEach(() => {
  configureAgentWorkTablePrefix('')
  resetAgentRunDatabaseForTests()
  closeDatabase()
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true })
  tempRoot = null
})

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
    await settings.write({ mode: 'remote', remoteBaseUrl: 'https://library.example' })
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

  it('refuses remote start when a local catalog exists and workStore is not ready', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    fs.writeFileSync(localCatalogDatabasePath(root), '')
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'https://library.example' })
    await assert.rejects(
      () => createDesktopRuntime(root, '0.7.0'),
      (error: unknown) => isStructuredError(error) && error.code === 'MODE_PREP_REQUIRED'
    )
    assert.throws(() => getDb(), /Database not initialised/)
  })

  it('starts remote after a completed local copy without reopening library.db', async () => {
    const root = tempDir()
    const local = await createDesktopRuntime(root, '0.7.0')
    assert.equal(local.workStore.prepStatus(), 'ready')
    await local.dispose()
    assert.throws(() => getDb(), /Database not initialised/)

    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'https://library.example' })
    const remote = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(remote.mode, 'remote')
      assert.equal(remote.openedCatalog, false)
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await remote.dispose()
    }
  })
})
