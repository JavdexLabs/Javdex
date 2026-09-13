import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, type Server } from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDatabase, getDb } from '@library/db/database'
import { configureAgentWorkTablePrefix } from '@library/runtime/host'
import { resetAgentRunDatabaseForTests } from '../agent-platform/agentRunStore'
import {
  createDesktopRuntime,
  localCatalogDatabasePath
} from './createDesktopRuntime'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from '../desktop/thisComputerSettingsStore'
import { createWriterCredentialStore, type WriterSecretCipher } from '../desktop/writerCredentialStore'

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

if (process.env.JAVDEX_D01_CHILD === '1') {
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

  async function prepareLocalCatalog(root: string): Promise<string> {
    const local = await createDesktopRuntime(root, '0.7.0')
    try {
      getDb().prepare("INSERT INTO actresses (main_name) VALUES ('Keep Closed')").run()
    } finally {
      await local.dispose()
    }
    return localCatalogDatabasePath(root)
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
  })
}
