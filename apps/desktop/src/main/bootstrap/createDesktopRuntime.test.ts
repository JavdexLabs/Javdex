import { readVideoAggregateVersion } from '@library/catalog/catalogAggregateVersion'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import { clearAgentRunDatabase } from '../agent-platform/agentRunStore'
import {
  createDesktopRuntime,
  localCatalogDatabasePath,
  workStorePath
} from './createDesktopRuntime'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../desktop/thisComputerSettingsStore'
import { copyAgentWorkTables } from '../desktop/agentWorkCopy'
import { openDesktopWorkStore } from '../desktop/workStore'
import { createWriterCredentialStore, type WriterSecretCipher } from '../desktop/writerCredentialStore'

function memoryCipher(): WriterSecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
  }
}

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
  clearAgentRunDatabase()
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
      assert.equal((getDb().prepare('PRAGMA database_list').all() as Array<{ name: string }>).some(row => row.name === 'work'), false)
      assert.equal(Object.hasOwn(getDb(), 'prepare'), false)
      assert.equal(Object.hasOwn(getDb(), 'exec'), false)
      assert.equal(
        (runtime.workStore.database().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS n FROM main.agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (runtime.workStore.database().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n,
        1
      )
      insertAgentRun(runtime.workStore.database(), 'run-after-switch')
      assert.equal(
        (getDb().prepare('SELECT COUNT(*) AS n FROM main.agent_runs').get() as { n: number }).n,
        1
      )
      assert.equal(
        (runtime.workStore.database().prepare("SELECT id FROM agent_runs ORDER BY id").all() as Array<{ id: string }>).map(
          (row) => row.id
        ).join(','),
        'run-after-switch,run-source'
      )
    } finally {
      await runtime.dispose()
    }
  })

  it('reopens ready local work without overwriting newer state from the original catalog', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
    insertAgentRun(catalog, 'run-original')
    closeDatabase()
    const first = await createDesktopRuntime(root, '0.7.1')
    first.workStore.database().prepare("UPDATE agent_runs SET product_state_json=? WHERE id='run-original'")
      .run('{"newer":true}')
    await first.dispose()
    const reopened = await createDesktopRuntime(root, '0.7.1')
    try {
      assert.equal(reopened.workStore.prepStatus(), 'ready')
      assert.deepEqual(reopened.workStore.database().prepare("SELECT product_state_json FROM agent_runs WHERE id='run-original'").get(),
        { product_state_json: '{"newer":true}' })
      assert.deepEqual(getDb().prepare("SELECT product_state_json FROM main.agent_runs WHERE id='run-original'").get(),
        { product_state_json: '{}' })
    } finally {
      await reopened.dispose()
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
        (runtime.workStore.database().prepare("SELECT id FROM agent_runs").get() as { id: string }).id,
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

  it('starts connected remote without opening library.db when a writer secret is present', async () => {
    const base = await listenHandshake('0.7.0', 1)
    const root = tempDir()
    const credentials = createWriterCredentialStore({ userDataPath: root, cipher: memoryCipher() })
    await credentials.writeWriterSecret('catalog-1', 'writer-secret')
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: base })
    const runtime = await createDesktopRuntime(root, '0.7.0', { credentials })
    try {
      assert.equal(runtime.mode, 'remote')
      assert.equal(runtime.openedCatalog, false)
      assert.equal(runtime.backend.session().state, 'available')
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

  it('does not let remote mode finish an interrupted workStore copy by opening library.db', async () => {
    const root = tempDir()
    fs.mkdirSync(path.join(root, 'data'), { recursive: true })
    const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
    insertAgentRun(catalog, 'run-partial')
    const store = openDesktopWorkStore(workStorePath(root))
    store.beginCopy()
    copyAgentWorkTables(catalog, store.database())
    store.close()
    closeDatabase()

    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const blocked = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(blocked.backend.session().state, 'modePrepRequired')
      assert.equal(blocked.openedCatalog, false)
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await blocked.dispose()
    }

    await settings.write({ mode: 'local', remoteBaseUrl: null })
    const resumed = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(resumed.workStore.prepStatus(), 'ready')
      assert.equal(
        (getDb().prepare("SELECT id FROM main.agent_runs").get() as { id: string }).id,
        'run-partial'
      )
      assert.equal(
        (resumed.workStore.database().prepare("SELECT id FROM agent_runs").get() as { id: string }).id,
        'run-partial'
      )
    } finally {
      await resumed.dispose()
    }
  })

  it('rebuilds a remote runtime without reopening library.db or re-registering window IPC', async () => {
    const source = fs.readFileSync(path.resolve('apps/desktop/src/main/appMain.ts'), 'utf8')
    const windowStart = source.indexOf('function createWindow')
    const windowEnd = source.indexOf('function registerAssetProtocol')
    assert.ok(windowStart >= 0 && windowEnd > windowStart)
    assert.equal(source.slice(windowStart, windowEnd).includes('registerIpcHandlers'), false)
    assert.equal(source.includes('registerIpcHandlers('), true)

    const root = tempDir()
    const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
    await settings.write({ mode: 'remote', remoteBaseUrl: 'http://127.0.0.1:1' })
    const first = await createDesktopRuntime(root, '0.7.0')
    assert.equal(first.openedCatalog, false)
    await first.dispose()
    assert.throws(() => getDb(), /Database not initialised/)
    const second = await createDesktopRuntime(root, '0.7.0')
    try {
      assert.equal(second.mode, 'remote')
      assert.equal(second.openedCatalog, false)
      assert.equal(second.backend.session().state, 'disconnected')
      assert.throws(() => getDb(), /Database not initialised/)
    } finally {
      await second.dispose()
    }
  })
})

it('recovers committed desktop drafts on startup and clears their binding on disposal', async () => {
  const { desktopAgentDraftRepo } = await import('../services/agentMetadata/desktopDraftStore')
  const { AgentMetadataApplyCommit } = await import('../services/agentMetadata/draftApplyCommit')
  const root = tempDir()
  let runtime = await createDesktopRuntime(root, '1.0.0')
  try {
    const work = runtime.workStore.database()
    insertAgentRun(work, 'draft-run')
    getDb().exec("INSERT INTO videos(id,code,title) VALUES(7,'ABC-007','before')")
    const draft = desktopAgentDraftRepo.create({ id: 'recover-draft', runId: 'draft-run',
      target: { kind: 'video', id: 7 },
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-007', title: 'after' },
        observedFields: ['title'], explicitlyEmptyFields: [], evidenceRefs: ['evidence'] },
      resources: [], warnings: [] }).draft
    desktopAgentDraftRepo.saveReview({ draftId: draft.id, expectedRevision: 1,
      review: { kind: 'video', draftId: draft.id, revision: 2, token: 'review',
        selection: { kind: 'video', draftId: draft.id, expectedRevision: 2, fields: ['title'], mode: 'replace' },
        impacts: [], warnings: [], classifications: [], canApply: true } })
    work.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF status ON agent_metadata_drafts
      WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'work failed'); END`)
    const commit = new AgentMetadataApplyCommit(work, getDb())
    assert.throws(() => commit.apply({ draftId: draft.id, reviewToken: 'review', idempotencyKey: 'caller-key' }, () => {
      getDb().prepare("UPDATE videos SET title='after', revision=revision+1 WHERE id=7").run()
      return { outcome: { status: 'applied', target: { kind: 'video', id: 7 }, warnings: [] },
        cleanup: { kind: 'video', stagedPaths: [] } }
    }, () => {}), /work failed/)
    const { videoLifecycleService } = await import('../services/videoLifecycleService')
    assert.throws(() => videoLifecycleService.deleteGlobally({ videoId: 7, operationId: 'blocked-delete',
      expectedRevision: 'unused' }), /未核对/)
    assert.ok(getDb().prepare('SELECT 1 FROM videos WHERE id=7').get())
    work.exec('DROP TRIGGER fail_completion')
    await runtime.dispose()
    assert.throws(() => desktopAgentDraftRepo.get(draft.id), /not configured/)
    runtime = await createDesktopRuntime(root, '1.0.0')
    assert.equal(desktopAgentDraftRepo.require(draft.id).status, 'applied')
    assert.equal((runtime.workStore.database().prepare('SELECT cleaned FROM agent_metadata_apply_intents').get() as { cleaned: number }).cleaned, 1)
    assert.equal((getDb().prepare('SELECT revision FROM videos WHERE id=7').get() as { revision: number }).revision, 2)
  } finally {
    await runtime.dispose()
  }
})

it('recovers desktop work-draft deletion after catalog commit and does not repeat completed cleanup', async () => {
  const { desktopAgentDraftRepo } = await import('../services/agentMetadata/desktopDraftStore')
  const { videoLifecycleService } = await import('../services/videoLifecycleService')
  const root = tempDir()
  let runtime = await createDesktopRuntime(root, '1.0.0')
  try {
    const work = runtime.workStore.database()
    insertAgentRun(work, 'delete-run')
    getDb().exec("INSERT INTO videos(id,code,title) VALUES(8,'ABC-008','delete')")
    desktopAgentDraftRepo.create({ id: 'delete-draft', runId: 'delete-run', target: { kind: 'video', id: 8 },
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-008' }, observedFields: [], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [], warnings: [] })
    const preview = videoLifecycleService.previewDeleteGlobally(8)
    work.exec(`CREATE TRIGGER fail_delete BEFORE DELETE ON agent_metadata_drafts
      BEGIN SELECT RAISE(ABORT,'work deletion failed'); END`)
    assert.throws(() => videoLifecycleService.deleteGlobally({ videoId: 8, operationId: 'delete-work',
      expectedRevision: preview.revision }), /work deletion failed/)
    assert.equal(getDb().prepare('SELECT 1 FROM videos WHERE id=8').get(), undefined)
    assert.ok(desktopAgentDraftRepo.get('delete-draft'))
    const { recoverDesktopVideoDraftCleanups, completeDesktopVideoDraftCleanup } = await import('../services/agentMetadata/desktopDraftStore')
    const receipt = getDb().prepare('SELECT result_json FROM video_lifecycle_operations WHERE id=?').get('delete-work') as { result_json: string }
    const foreign = { ...JSON.parse(receipt.result_json), agentDraftCleanupCatalogId: 'another-catalog' }
    getDb().prepare('UPDATE video_lifecycle_operations SET result_json=? WHERE id=?').run(JSON.stringify(foreign), 'delete-work')
    assert.throws(() => completeDesktopVideoDraftCleanup(foreign), /不属于当前资料库/)
    recoverDesktopVideoDraftCleanups()
    assert.ok(desktopAgentDraftRepo.get('delete-draft'))
    assert.equal(work.prepare('SELECT 1 FROM agent_video_delete_cleanups').get(), undefined)
    getDb().prepare('UPDATE video_lifecycle_operations SET result_json=? WHERE id=?').run(receipt.result_json, 'delete-work')
    work.exec('DROP TRIGGER fail_delete')
    await runtime.dispose()
    runtime = await createDesktopRuntime(root, '1.0.0')
    assert.equal(desktopAgentDraftRepo.get('delete-draft'), null)
    assert.equal((runtime.workStore.database().prepare('SELECT COUNT(*) AS n FROM agent_video_delete_cleanups').get() as { n: number }).n, 1)
    await runtime.dispose()
    runtime = await createDesktopRuntime(root, '1.0.0')
    assert.equal((runtime.workStore.database().prepare('SELECT COUNT(*) AS n FROM agent_video_delete_cleanups').get() as { n: number }).n, 1)
  } finally {
    await runtime.dispose()
  }
})

it('applies managed metadata through the explicit work store with a durable catalog receipt', async () => {
  const { desktopAgentDraftRepo } = await import('../services/agentMetadata/desktopDraftStore')
  const { randomUUID } = await import('node:crypto')
  const root = tempDir()
  const runtime = await createDesktopRuntime(root, '1.0.0')
  try {
    const work = runtime.workStore.database()
    insertAgentRun(work, 'managed-run')
    getDb().exec("INSERT INTO videos(id,code,title) VALUES(9,'ABC-009','before')")
    desktopAgentDraftRepo.create({ id: 'managed-draft', runId: 'managed-run', target: { kind: 'video', id: 9 },
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-009', title: 'managed' },
        observedFields: ['title'], explicitlyEmptyFields: [], evidenceRefs: [] }, resources: [], warnings: [] })
    desktopAgentDraftRepo.saveReview({ draftId: 'managed-draft', expectedRevision: 1, review: {
      kind: 'video', draftId: 'managed-draft', revision: 2, token: 'review',
      selection: { kind: 'video', draftId: 'managed-draft', expectedRevision: 2, fields: ['title'], mode: 'replace' },
      impacts: [], warnings: [], classifications: [], canApply: true
    } })
    const ready = await runtime.backend.agentMetadata.findReady({ target: { kind: 'video', id: 9 } }) as { draft: { id: string } }
    assert.equal(ready.draft.id, 'managed-draft')
    const input = { draftId: 'managed-draft', reviewToken: 'review' }
    const ctx = { operationId: randomUUID(), expectedVersions: {
      V: readVideoAggregateVersion(9)!, Q: { generation: 1, revision: 2 }
    } }
    work.exec(`CREATE TRIGGER fail_managed_completion BEFORE UPDATE OF status ON agent_metadata_drafts
      WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'managed completion failed'); END`)
    await assert.rejects(runtime.backend.agentMetadata.apply(input, ctx), /managed completion failed/)
    assert.equal(desktopAgentDraftRepo.require('managed-draft').status, 'ready')
    const committed = getDb().prepare('SELECT title,revision FROM videos WHERE id=9').get()
    assert.equal((committed as { title: string }).title, 'managed')
    assert.ok(getDb().prepare('SELECT 1 FROM catalog_operation_receipts WHERE operation_id=?').get(ctx.operationId))
    work.exec('DROP TRIGGER fail_managed_completion')
    await runtime.backend.agentMetadata.apply(input, ctx)
    assert.equal(desktopAgentDraftRepo.require('managed-draft').status, 'applied')
    assert.deepEqual(getDb().prepare('SELECT title,revision FROM videos WHERE id=9').get(), committed)
    assert.equal(getDb().prepare('SELECT 1 FROM main.agent_metadata_drafts WHERE id=?').get('managed-draft'), undefined)
    await assert.rejects(runtime.backend.agentMetadata.apply(input, { ...ctx, expectedVersions: {} }), /原请求重试/)
  } finally {
    await runtime.dispose()
  }
})

it('recovers managed discard after work mutation failure without repeating or changing the request', async () => {
  const { desktopAgentDraftRepo } = await import('../services/agentMetadata/desktopDraftStore')
  const { randomUUID } = await import('node:crypto')
  const root = tempDir()
  let runtime = await createDesktopRuntime(root, '1.0.0')
  try {
    const work = runtime.workStore.database()
    insertAgentRun(work, 'discard-run')
    desktopAgentDraftRepo.create({ id: 'discard-draft', runId: 'discard-run', target: { kind: 'video', id: 1 },
      source: { requestedUrl: 'https://example.test', displayUrl: 'https://example.test' },
      payload: { kind: 'video', result: { code: 'ABC-001' }, observedFields: [], explicitlyEmptyFields: [], evidenceRefs: [] },
      resources: [], warnings: [] })
    const input = { draftId: 'discard-draft' }
    const ctx = { operationId: randomUUID(), expectedVersions: { Q: { generation: 1, revision: 1 } } }
    await assert.rejects(runtime.backend.agentMetadata.discard(input, { ...ctx, expectedVersions: {} }))
    assert.equal(work.prepare('SELECT 1 FROM agent_metadata_discard_intents').get(), undefined)
    work.exec(`CREATE TRIGGER fail_discard BEFORE UPDATE OF status ON agent_metadata_drafts
      WHEN NEW.status='discarded' BEGIN SELECT RAISE(ABORT,'discard write failed'); END`)
    await assert.rejects(runtime.backend.agentMetadata.discard(input, ctx), /discard write failed/)
    assert.equal(desktopAgentDraftRepo.require(input.draftId).status, 'ready')
    assert.ok(getDb().prepare('SELECT 1 FROM catalog_operation_receipts WHERE operation_id=?').get(ctx.operationId))
    const { desktopDraftApplyCommit } = await import('../services/agentMetadata/desktopDraftStore')
    assert.throws(() => desktopDraftApplyCommit()!.assertMutable(input.draftId), /未核对/)
    work.exec('DROP TRIGGER fail_discard')
    await runtime.dispose()
    runtime = await createDesktopRuntime(root, '1.0.0')
    assert.equal(desktopAgentDraftRepo.require(input.draftId).status, 'discarded')
    assert.equal(desktopAgentDraftRepo.require(input.draftId).revision, 2)
    assert.deepEqual(await runtime.backend.agentMetadata.discard(input, ctx), { ok: true })
    assert.equal(desktopAgentDraftRepo.require(input.draftId).revision, 2)
    await assert.rejects(runtime.backend.agentMetadata.discard(input, { ...ctx, operationId: randomUUID() }), /原草稿丢弃请求/)
    assert.equal((runtime.workStore.database().prepare('SELECT cleaned FROM agent_metadata_discard_intents').get() as { cleaned: number }).cleaned, 1)
  } finally {
    await runtime.dispose()
  }
})
