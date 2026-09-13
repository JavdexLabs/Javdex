import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { configureAgentWorkTablePrefix } from '@library/runtime/host'
import { resetAgentRunDatabaseForTests } from '../agent-platform/agentRunStore'
import {
  createDesktopRuntime,
  localCatalogDatabasePath,
  workStorePath
} from './createDesktopRuntime'
import { copyAgentWorkTables } from '../desktop/agentWorkCopy'
import { openDesktopWorkStore } from '../desktop/workStore'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../desktop/thisComputerSettingsStore'
import { createWriterCredentialStore, type WriterSecretCipher } from '../desktop/writerCredentialStore'
import { agentMetadataCollection } from '../services/agentMetadata/agentMetadataCollection'
import { libraryCurator, readCuratorOverview } from '../services/libraryCuratorAgent/libraryCurator'
import { loadCatalogActressAvatarCropSnapshot } from '../services/catalogActressAvatarCropSnapshot'
import { createPlaylistImportModule } from '../services/playlistImport/playlistImportModule'

const thisFile = fileURLToPath(import.meta.url)

function isolationCipher(): WriterSecretCipher {
  return {
    isAvailable: () => true,
    encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
  }
}

function catalogArtifacts(catalogPath: string): string[] {
  return [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`]
}

function listLibraryDbFds(pid: number, catalogPath: string): string[] {
  const hits: string[] = []
  const dir = `/proc/${pid}/fd`
  if (!fs.existsSync(dir)) return hits
  for (const fd of fs.readdirSync(dir)) {
    try {
      const target = fs.readlinkSync(path.join(dir, fd))
      if (catalogArtifacts(catalogPath).some((artifact) => target === artifact || target.startsWith(`${artifact} `))) {
        hits.push(target)
      }
    } catch {
      // Descriptor disappeared between readdir and readlink.
    }
  }
  return hits
}

function chmodCatalogClosed(catalogPath: string): () => void {
  const files = catalogArtifacts(catalogPath).filter((file) => fs.existsSync(file))
  const modes = files.map((file) => fs.statSync(file).mode)
  for (const file of files) fs.chmodSync(file, 0)
  return () => {
    files.forEach((file, index) => {
      try {
        fs.chmodSync(file, modes[index])
      } catch {
        // Parent may have already restored modes.
      }
    })
  }
}

if (process.env.JAVDEX_D03_CHILD === '1') {
  const root = process.env.JAVDEX_TEST_USER_DATA
  if (!root) {
    process.stderr.write('JAVDEX_TEST_USER_DATA is required\n')
    process.exit(1)
  }
  void (async () => {
    try {
      const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
      const store = openDesktopWorkStore(workStorePath(root))
      store.beginCopy()
      fs.writeFileSync(path.join(root, 'd03-sentinel'), 'copying')
      const holdMs = Number(process.env.JAVDEX_D03_HOLD_MS ?? '2000')
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(holdMs) ? holdMs : 2000))
      copyAgentWorkTables(catalog, store.database())
      store.markReady()
      process.stdout.write('ready\n')
      await new Promise<void>(() => undefined)
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    }
  })()
} else if (process.env.JAVDEX_D01_CHILD === '1') {
  const root = process.env.JAVDEX_TEST_USER_DATA
  if (!root) {
    process.stderr.write('JAVDEX_TEST_USER_DATA is required\n')
    process.exit(1)
  }
  const credentials = process.env.JAVDEX_D01_TEST_CIPHER
    ? createWriterCredentialStore({ userDataPath: root, cipher: isolationCipher() })
    : undefined
  void createDesktopRuntime(root, process.env.JAVDEX_D01_APP_VERSION ?? '0.7.0', {
    ...(credentials ? { credentials } : {})
  })
    .then((runtime) => {
      const catalogPath = localCatalogDatabasePath(root)
      process.stdout.write(
        `${JSON.stringify({
          openedCatalog: runtime.openedCatalog,
          state: runtime.backend.session().state,
          scanRecovery: runtime.scanRecovery,
          fds: listLibraryDbFds(process.pid, catalogPath)
        })}\n`
      )
      return new Promise<void>(() => undefined)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    })
} else if (process.env.JAVDEX_M10_CHILD === '1') {
  const root = process.env.JAVDEX_TEST_USER_DATA
  if (!root) {
    process.stderr.write('JAVDEX_TEST_USER_DATA is required\n')
    process.exit(1)
  }
  const credentials = process.env.JAVDEX_D01_TEST_CIPHER
    ? createWriterCredentialStore({ userDataPath: root, cipher: isolationCipher() })
    : undefined
  void createDesktopRuntime(root, process.env.JAVDEX_D01_APP_VERSION ?? '0.7.0', {
    ...(credentials ? { credentials } : {})
  })
    .then(async (runtime) => {
      const catalogPath = localCatalogDatabasePath(root)
      agentMetadataCollection.bindCatalog(runtime.backend)
      libraryCurator.bindCatalog(runtime.backend)
      const errorMessage = (error: unknown): string =>
        error instanceof Error ? error.message : String(error)
      const probe = async (work: () => Promise<unknown>): Promise<{ ok: boolean; error: string }> => {
        try {
          await work()
          return { ok: true, error: '' }
        } catch (error) {
          return { ok: false, error: errorMessage(error) }
        }
      }
      const collection = await probe(() =>
        agentMetadataCollection.start({
          target: { kind: 'video', id: 1 },
          sourceUrl: '',
          idempotencyKey: 'm10-collection'
        })
      )
      const curator = await probe(() => readCuratorOverview(runtime.backend))
      const crop = await probe(async () => {
        const snapshot = await loadCatalogActressAvatarCropSnapshot(runtime.backend)
        snapshot.page(0)
        snapshot.dispose()
      })
      const playlist = await probe(async () => {
        const module = await createPlaylistImportModule({
          catalog: runtime.backend,
          database: () => runtime.workStore.database()
        })
        return module.start({
          idempotencyKey: 'm10-isolation',
          sourceUrl: 'https://example.test/list',
          targetLibraryId: 1,
          destination: { kind: 'create' }
        })
      })
      let getDbError = ''
      try {
        getDb()
      } catch (error) {
        getDbError = errorMessage(error)
      }
      process.stdout.write(
        `${JSON.stringify({
          openedCatalog: runtime.openedCatalog,
          state: runtime.backend.session().state,
          fds: listLibraryDbFds(process.pid, catalogPath),
          getDbError,
          collection,
          curator,
          crop,
          playlist
        })}\n`
      )
      return new Promise<void>(() => undefined)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    })
} else {
  let tempRoot: string | null = null
  let handshakeServer: Server | null = null
  const children: ChildProcess[] = []

  function tempDir(): string {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s13-d01-'))
    return tempRoot
  }

  async function stopChild(child: ChildProcess): Promise<void> {
    const index = children.indexOf(child)
    if (index >= 0) children.splice(index, 1)
    if (child.exitCode != null || child.signalCode) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }

  afterEach(async () => {
    configureAgentWorkTablePrefix('')
    resetAgentRunDatabaseForTests()
    closeDatabase()
    await Promise.all(children.splice(0).map((child) => stopChild(child)))
    if (handshakeServer) {
      await new Promise<void>((resolve, reject) =>
        handshakeServer!.close((error) => (error ? reject(error) : resolve()))
      )
      handshakeServer = null
    }
    if (tempRoot) {
      const catalogPath = localCatalogDatabasePath(tempRoot)
      for (const file of catalogArtifacts(catalogPath)) {
        try {
          fs.chmodSync(file, 0o644)
        } catch {
          // File may not exist.
        }
      }
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
    tempRoot = null
  })

  function listenHandshake(appVersion: string, writerEpoch = 1): Promise<string> {
    handshakeServer = createHttpServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          appVersion,
          schemaVersion: 19,
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

  async function spawnRemoteChild(
    root: string,
    appVersion: string,
    options: { testCipher?: boolean } = {}
  ): Promise<{
    child: ChildProcess
    report: {
      openedCatalog: boolean
      state: string
      scanRecovery: unknown
      fds: string[]
    }
  }> {
    const child = spawn(
      process.execPath,
      [
        '--require',
        './scripts/register-test-paths.cjs',
        '--import',
        './scripts/register-test-styles.mjs',
        '--import',
        'tsx',
        '--import',
        './scripts/register-library-test-host.ts',
        thisFile
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          JAVDEX_D01_CHILD: '1',
          JAVDEX_TEST_USER_DATA: root,
          JAVDEX_D01_APP_VERSION: appVersion,
          ...(options.testCipher ? { JAVDEX_D01_TEST_CIPHER: '1' } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    children.push(child)
    const report = await new Promise<{
      openedCatalog: boolean
      state: string
      scanRecovery: unknown
      fds: string[]
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`d01 child did not report\n${stderr}`)), 20_000)
      let stdout = ''
      let stderr = ''
      const onOut = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8')
        const line = stdout.split('\n').find((entry) => entry.startsWith('{'))
        if (line) {
          clearTimeout(timeout)
          child.stdout?.off('data', onOut)
          resolve(JSON.parse(line) as {
            openedCatalog: boolean
            state: string
            scanRecovery: unknown
            fds: string[]
          })
        }
      }
      const onErr = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
      }
      child.stdout?.on('data', onOut)
      child.stderr?.on('data', onErr)
      child.on('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`d01 child exited ${code}\n${stdout}\n${stderr}`))
      })
    })
    return { child, report }
  }

  type M10Probe = { ok: boolean; error: string }
  type M10Report = {
    openedCatalog: boolean
    state: string
    fds: string[]
    getDbError: string
    collection: M10Probe
    curator: M10Probe
    crop: M10Probe
    playlist: M10Probe
  }

  async function spawnM10Child(root: string): Promise<{ child: ChildProcess; report: M10Report }> {
    const child = spawn(
      process.execPath,
      [
        '--require',
        './scripts/register-test-paths.cjs',
        '--import',
        './scripts/register-test-styles.mjs',
        '--import',
        'tsx',
        '--import',
        './scripts/register-library-test-host.ts',
        thisFile
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          JAVDEX_M10_CHILD: '1',
          JAVDEX_TEST_USER_DATA: root,
          JAVDEX_D01_APP_VERSION: '0.7.0',
          JAVDEX_D01_TEST_CIPHER: '1'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    children.push(child)
    const report = await new Promise<M10Report>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`m10 child did not report\n${stderr}`)), 30_000)
      let stdout = ''
      let stderr = ''
      const onOut = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8')
        const line = stdout.split('\n').find((entry) => entry.startsWith('{'))
        if (line) {
          clearTimeout(timeout)
          child.stdout?.off('data', onOut)
          resolve(JSON.parse(line) as M10Report)
        }
      }
      const onErr = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
      }
      child.stdout?.on('data', onOut)
      child.stderr?.on('data', onErr)
      child.on('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`m10 child exited ${code}\n${stdout}\n${stderr}`))
      })
    })
    return { child, report }
  }

  async function prepareLocalCatalog(root: string): Promise<string> {
    const local = await createDesktopRuntime(root, '0.7.0')
    try {
      getDb().prepare("INSERT INTO actresses (main_name) VALUES ('Keep Closed')").run()
    } finally {
      await local.dispose()
    }
    return localCatalogDatabasePath(root)
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

  async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fs.existsSync(filePath)) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`missing ${filePath}`)
  }

  describe('createDesktopRuntime process isolation', () => {
    it('keeps local-mode library.db descriptors and releases them on dispose', async () => {
      const root = tempDir()
      const runtime = await createDesktopRuntime(root, '0.7.0')
      const catalogPath = localCatalogDatabasePath(root)
      try {
        assert.equal(runtime.openedCatalog, true)
        assert.equal(listLibraryDbFds(process.pid, catalogPath).length > 0, true)
      } finally {
        await runtime.dispose()
      }
      assert.equal(listLibraryDbFds(process.pid, catalogPath).length, 0)
    })

    it('starts remote disconnect, version mismatch, and recoveryRequired without opening library.db', async () => {
      const cases: Array<{ name: string; url: () => Promise<string>; appVersion: string; state: string }> = [
        {
          name: 'disconnected',
          url: async () => 'http://127.0.0.1:1',
          appVersion: '0.7.0',
          state: 'disconnected'
        },
        {
          name: 'versionMismatch',
          url: () => listenHandshake('9.9.9-other'),
          appVersion: '0.7.0',
          state: 'versionMismatch'
        },
        {
          name: 'recoveryRequired',
          url: () => listenHandshake('0.7.0', 1),
          appVersion: '0.7.0',
          state: 'recoveryRequired'
        }
      ]
      for (const testCase of cases) {
        if (handshakeServer) {
          await new Promise<void>((resolve, reject) =>
            handshakeServer!.close((error) => (error ? reject(error) : resolve()))
          )
          handshakeServer = null
        }
        const root = fs.mkdtempSync(path.join(os.tmpdir(), `javdex-s13-d01-${testCase.name}-`))
        tempRoot = root
        const catalogPath = await prepareLocalCatalog(root)
        const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
        await settings.write({ mode: 'remote', remoteBaseUrl: await testCase.url() })
        const restore = chmodCatalogClosed(catalogPath)
        try {
          const { child, report } = await spawnRemoteChild(root, testCase.appVersion)
          assert.equal(report.openedCatalog, false, testCase.name)
          assert.equal(report.state, testCase.state, testCase.name)
          assert.equal(report.scanRecovery, null, testCase.name)
          assert.deepEqual(report.fds, [], testCase.name)
          assert.deepEqual(listLibraryDbFds(child.pid ?? 0, catalogPath), [], testCase.name)
          await stopChild(child)
        } finally {
          restore()
        }
        fs.rmSync(root, { recursive: true, force: true })
        tempRoot = null
      }
    })

    it('starts connected remote without opening library.db even when the local catalog is unreadable', async () => {
      const root = tempDir()
      const catalogPath = await prepareLocalCatalog(root)
      const credentials = createWriterCredentialStore({ userDataPath: root, cipher: isolationCipher() })
      await credentials.writeWriterSecret('catalog-1', 'd01-writer-secret')
      const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
      await settings.write({ mode: 'remote', remoteBaseUrl: await listenHandshake('0.7.0', 1) })
      const restore = chmodCatalogClosed(catalogPath)
      try {
        const { child, report } = await spawnRemoteChild(root, '0.7.0', { testCipher: true })
        assert.equal(report.openedCatalog, false)
        assert.equal(report.state, 'available')
        assert.equal(report.scanRecovery, null)
        assert.deepEqual(report.fds, [])
        assert.deepEqual(listLibraryDbFds(child.pid ?? 0, catalogPath), [])
        await stopChild(child)
      } finally {
        restore()
      }
    })

    it('starts remote collection, curator overview, crop, and playlist import without opening library.db', { timeout: 60_000 }, async () => {
      const root = tempDir()
      const catalogPath = await prepareLocalCatalog(root)
      const credentials = createWriterCredentialStore({ userDataPath: root, cipher: isolationCipher() })
      await credentials.writeWriterSecret('catalog-1', 'd01-writer-secret')
      const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
      await settings.write({ mode: 'remote', remoteBaseUrl: await listenHandshake('0.7.0', 1) })
      const restore = chmodCatalogClosed(catalogPath)
      try {
        const { child, report } = await spawnM10Child(root)
        assert.equal(report.openedCatalog, false)
        assert.equal(report.state, 'available')
        assert.deepEqual(report.fds, [])
        assert.deepEqual(listLibraryDbFds(child.pid ?? 0, catalogPath), [])
        assert.match(report.getDbError, /Database not initialised/)
        for (const probe of [report.collection, report.curator, report.crop, report.playlist] as const) {
          assert.equal(probe.ok, false, probe.error)
          assert.equal(/Database not initialised/i.test(probe.error), false, probe.error)
          assert.ok(probe.error.length > 0, 'probe must fail through the catalog, not silently')
        }
        await stopChild(child)
      } finally {
        restore()
      }
    })

    it('keeps source agent rows and stays copying when SIGKILL hits workStore copy', async () => {
      const root = tempDir()
      fs.mkdirSync(path.join(root, 'data'), { recursive: true })
      const catalog = initDatabaseAtPath(localCatalogDatabasePath(root))
      insertAgentRun(catalog, 'run-d03-kill')
      closeDatabase()

      const child = spawn(
        process.execPath,
        [
          '--require',
          './scripts/register-test-paths.cjs',
          '--import',
          './scripts/register-test-styles.mjs',
          '--import',
          'tsx',
          '--import',
          './scripts/register-library-test-host.ts',
          thisFile
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            JAVDEX_D03_CHILD: '1',
            JAVDEX_D03_HOLD_MS: '4000',
            JAVDEX_TEST_USER_DATA: root
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      children.push(child)
      await waitForFile(path.join(root, 'd03-sentinel'))
      const killed = child.kill('SIGKILL')
      assert.equal(killed, true)
      await new Promise<void>((resolve) => {
        if (child.exitCode != null || child.signalCode) {
          resolve()
          return
        }
        child.once('exit', () => resolve())
      })
      const index = children.indexOf(child)
      if (index >= 0) children.splice(index, 1)

      const interrupted = openDesktopWorkStore(workStorePath(root))
      try {
        assert.equal(interrupted.prepStatus(), 'copying')
        assert.equal(
          (interrupted.database().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number }).n,
          0
        )
      } finally {
        interrupted.close()
      }

      const source = initDatabaseAtPath(localCatalogDatabasePath(root))
      assert.equal(
        (source.prepare("SELECT id FROM agent_runs WHERE id = 'run-d03-kill'").get() as { id: string }).id,
        'run-d03-kill'
      )
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
          (getDb().prepare("SELECT id FROM main.agent_runs").get() as { id: string } | undefined)?.id,
          'run-d03-kill'
        )
        assert.equal(
          (resumed.workStore.database().prepare("SELECT id FROM agent_runs").get() as { id: string }).id,
          'run-d03-kill'
        )
      } finally {
        await resumed.dispose()
      }
    })
  })
}
