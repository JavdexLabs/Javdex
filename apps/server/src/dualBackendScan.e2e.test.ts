import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { buildSync } from 'esbuild'
import { hashPassword } from '@http/auth'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { configureLibraryHost, resetLibraryHostForTests } from '@library/runtime/host'
import { scanCoordinator } from '@library/scan/scanCoordinator'
import { resetCatalogScanRuntime } from '@library/catalog/catalogScanRuntime'
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import type { MediaLibraryDetail } from '@shared/mediaLibraryTypes'
import type { NfoExportOptions, NfoExportPlanPreview } from '@shared/nfoExportTypes'
import type { ScopedVideoListResult } from '@shared/catalogTypes'
import type { LibraryScanLatestSnapshot } from '@shared/libraryTypes'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'
import { ipcMutation } from '../../desktop/src/main/application/mutationContext'
import { createLocalCatalogBackend } from '../../desktop/src/main/backends/local/localCatalogBackend'
import { createRemoteCatalogBackend } from '../../desktop/src/main/backends/remote/remoteCatalogBackend'
import { loadOrCreateLocalCatalogIdentity, localCatalogIdentityPath } from '../../desktop/src/main/desktop/localCatalogIdentity'
import { issueDeployToken } from './identity'
import { startJavdexServer } from './runtime'
import type { ServerConfig } from './config'
import { SERVER_APP_VERSION } from './appVersion'

const hostConfigRaw = process.env.JAVDEX_TEST_HOST_CONFIG
if (hostConfigRaw) {
  const workerEntry = process.env.JAVDEX_TEST_HOST_WORKER
  if (!workerEntry) {
    process.stderr.write('JAVDEX_TEST_HOST_WORKER is required\n')
    process.exit(1)
  }
  const config = JSON.parse(hostConfigRaw) as ServerConfig
  void startJavdexServer(config, { workerEntry })
    .then((server) => {
      process.stdout.write(`listening ${config.listenHost}:${server.port}\n`)
      const shutdown = (): void => {
        void server.stop().finally(() => process.exit(0))
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exit(1)
    })
} else {
  const thisFile = fileURLToPath(import.meta.url)

  function versionsFrom(library: MediaLibraryDetail) {
    return {
      L: { generation: 1, revision: library.revision },
      C: { generation: 1, revision: library.config.revision },
      G: { generation: 1, revision: 1 },
      V: { generation: 1, revision: 1 },
      R: { generation: 1, revision: 1 }
    }
  }

  function memoryCredentials(entries: Map<string, string>) {
    return {
      async isAvailable(): Promise<boolean> {
        return true
      },
      async readWriterSecret(catalogId: string): Promise<string | null> {
        return entries.get(catalogId) ?? null
      },
      async writeWriterSecret(catalogId: string, secret: string): Promise<void> {
        entries.set(catalogId, secret)
      },
      async deleteWriterSecret(catalogId: string): Promise<void> {
        entries.delete(catalogId)
      }
    }
  }

  async function postManage(
    base: string,
    operation: string,
    body: unknown,
    bearer?: string
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-App-Version': SERVER_APP_VERSION
    }
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    const response = await fetch(`${base}/manage/v1/${operation}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
    return { status: response.status, json: await response.json() }
  }

  async function waitListening(child: ChildProcess): Promise<number> {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`host did not listen\n${stderr}`)), 20_000)
      let stdout = ''
      let stderr = ''
      const onOut = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8')
        const match = /listening 127\.0\.0\.1:(\d+)/.exec(stdout)
        if (match) {
          clearTimeout(timeout)
          child.stdout?.off('data', onOut)
          child.off('exit', onExit)
          resolve(Number(match[1]))
        }
      }
      const onErr = (chunk: Buffer): void => {
        stderr += chunk.toString('utf8')
      }
      const onExit = (code: number | null): void => {
        clearTimeout(timeout)
        reject(new Error(`host exited ${code}\n${stdout}\n${stderr}`))
      }
      child.stdout?.on('data', onOut)
      child.stderr?.on('data', onErr)
      child.on('exit', onExit)
    })
  }

  async function waitTask(backend: { tasks: { get: (input: { taskId: string }) => Promise<unknown> } }, taskId: string) {
    const deadline = Date.now() + 60_000
    let last: CatalogTaskSnapshot | undefined
    while (Date.now() < deadline) {
      last = (await backend.tasks.get({ taskId })) as CatalogTaskSnapshot
      if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
  }

  describe('local CatalogBackend vs Node host scan/NFO', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s13-d02-'))
    const workerEntry = path.join(root, 'webCatalogWorker.js')
    const staticRoot = path.join(root, 'web')
    const children: ChildProcess[] = []
    let passwordHash = ''

    before(async () => {
      fs.mkdirSync(staticRoot)
      fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Javdex</title>')
      passwordHash = await hashPassword('correct horse battery')
      buildSync({
        entryPoints: [path.resolve('apps/server/src/webCatalogWorker.ts')],
        outfile: workerEntry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        absWorkingDir: process.cwd(),
        alias: {
          '@shared': path.resolve('packages/contracts/src'),
          '@library': path.resolve('packages/library/src'),
          '@http': path.resolve('packages/http/src')
        },
        banner: {
          js: `require = require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});`
        }
      })
    })

    after(async () => {
      await Promise.all(
        children.splice(0).map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.exitCode != null || child.signalCode) {
                resolve()
                return
              }
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
        )
      )
      await scanCoordinator.stopAndDrain().catch(() => undefined)
      scanCoordinator.resetAfterStop()
      resetCatalogScanRuntime()
      closeDatabase()
      resetLibraryHostForTests()
      fs.rmSync(root, { recursive: true, force: true })
    })

    it('runs the same scan and XML NFO plan through LocalCatalogBackend and RemoteCatalogBackend', async () => {
      const remoteDir = path.join(root, 'remote-host')
      const localDir = path.join(root, 'local-desktop')
      const remoteMount = path.join(root, 'remote-media')
      const localMount = path.join(root, 'local-media')
      for (const dir of [remoteDir, localDir, remoteMount, localMount]) fs.mkdirSync(dir)
      fs.mkdirSync(path.join(remoteDir, 'media_assets'), { recursive: true })
      fs.mkdirSync(path.join(localDir, 'media_assets'), { recursive: true })
      fs.writeFileSync(path.join(remoteMount, 'ABC-001.mp4'), Buffer.from('0123456789abcdef'))
      fs.writeFileSync(path.join(localMount, 'ABC-001.mp4'), Buffer.from('0123456789abcdef'))

      const remoteConfig: ServerConfig = {
        listenHost: '127.0.0.1',
        port: 0,
        accessHosts: ['127.0.0.1'],
        dataDir: remoteDir,
        imagesDir: path.join(remoteDir, 'media_assets'),
        staticRoot,
        mediaMounts: { media: remoteMount },
        web: { username: 'viewer', passwordHash }
      }
      const issued = issueDeployToken(remoteConfig, 'initialBind')
      const child = spawn(
        process.execPath,
        ['--require', './scripts/register-test-paths.cjs', '--import', 'tsx', thisFile],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '',
            TSX_TSCONFIG_PATH: 'tsconfig.server.json',
            JAVDEX_TEST_HOST_CONFIG: JSON.stringify(remoteConfig),
            JAVDEX_TEST_HOST_WORKER: workerEntry,
            JAVDEX_TEST_USER_DATA: remoteDir
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      children.push(child)
      const remotePort = await waitListening(child)
      const base = `http://127.0.0.1:${remotePort}`

      const handshake = await postManage(base, 'handshake.get', { input: {} })
      assert.equal(handshake.status, 200, JSON.stringify(handshake.json))
      const hello = handshake.json as { identity: { serverId: string; catalogId: string }; writerEpoch: number }
      const secret = generateSecret()
      const claim = await postManage(base, 'writer.claim', {
        serverId: hello.identity.serverId,
        catalogId: hello.identity.catalogId,
        input: {
          kind: 'initialBind',
          oneTimeToken: issued.oneTimeToken,
          candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) }
        }
      })
      assert.equal(claim.status, 200, JSON.stringify(claim.json))

      resetLibraryHostForTests()
      process.env.JAVDEX_TEST_USER_DATA = localDir
      configureLibraryHost({
        userDataPath: () => localDir,
        assets: { assetEncryption: () => false, mediaAssetsPath: () => path.join(localDir, 'media_assets') }
      })
      initDatabaseAtPath(path.join(localDir, 'library.db'))
      getDb()
        .prepare(
          `UPDATE media_library_configs
              SET min_import_duration_minutes = 0, auto_import_local_nfo = 0
            WHERE library_id = 1`
        )
        .run()

      const local = createLocalCatalogBackend({
        identity: loadOrCreateLocalCatalogIdentity(localCatalogIdentityPath(localDir)),
        appVersion: SERVER_APP_VERSION
      })
      const remote = createRemoteCatalogBackend({
        baseUrl: base,
        appVersion: SERVER_APP_VERSION,
        credentials: memoryCredentials(new Map([[hello.identity.catalogId, secret]]))
      })

      try {
        let localLibrary = (await local.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        await local.libraries.addRoot(
          {
            libraryId: 1,
            expectedRevision: localLibrary.revision,
            root: { path: localMount }
          },
          ipcMutation()
        )
        const localScan = (await local.libraries.runScan({ libraryId: 1 }, ipcMutation())) as { taskId: string }
        const localTask = await waitTask(local, localScan.taskId)
        assert.equal(['succeeded', 'needsInspection'].includes(localTask.state), true, JSON.stringify(localTask))

        let remoteLibrary = (await remote.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        await remote.libraries.updateConfig(
          { libraryId: 1, patch: { minImportDurationMinutes: 0, autoImportLocalNfo: false } },
          ipcMutation(undefined, versionsFrom(remoteLibrary))
        )
        remoteLibrary = (await remote.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        await remote.libraries.addRoot(
          { libraryId: 1, root: { mountSelectionId: 'media' } },
          ipcMutation(undefined, versionsFrom(remoteLibrary))
        )
        remoteLibrary = (await remote.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        const remoteScan = (await remote.libraries.runScan(
          { libraryId: 1 },
          ipcMutation(undefined, versionsFrom(remoteLibrary))
        )) as { taskId: string }
        const remoteTask = await waitTask(remote, remoteScan.taskId)
        assert.equal(['succeeded', 'needsInspection'].includes(remoteTask.state), true, JSON.stringify(remoteTask))

        const localLatest = (await local.libraries.latestScan({ libraryId: 1 })) as LibraryScanLatestSnapshot
        const remoteLatest = (await remote.libraries.latestScan({ libraryId: 1 })) as LibraryScanLatestSnapshot
        assert.equal(localLatest.summary?.status, 'success', JSON.stringify(localLatest))
        assert.equal(remoteLatest.summary?.status, 'success', JSON.stringify(remoteLatest))
        assert.equal((localLatest.summary?.scannedFiles ?? 0) >= 1, true, JSON.stringify(localLatest))
        assert.equal((remoteLatest.summary?.scannedFiles ?? 0) >= 1, true, JSON.stringify(remoteLatest))

        const localVideos = (await local.queries.listVideos({ scope: { kind: 'all' } })) as ScopedVideoListResult
        const remoteVideos = (await remote.queries.listVideos({ scope: { kind: 'all' } })) as ScopedVideoListResult
        assert.equal(localVideos.items.some((item) => item.code === 'ABC-001'), true, JSON.stringify(localVideos))
        assert.equal(remoteVideos.items.some((item) => item.code === 'ABC-001'), true, JSON.stringify(remoteVideos))

        const localNfo = (await local.nfo.getOptions({})) as NfoExportOptions
        const remoteNfo = (await remote.nfo.getOptions({})) as NfoExportOptions
        assert.deepEqual(
          localNfo.profiles.map((profile) => profile.id).sort(),
          remoteNfo.profiles.map((profile) => profile.id).sort()
        )

        localLibrary = (await local.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        remoteLibrary = (await remote.libraries.get({ libraryId: 1 })) as MediaLibraryDetail
        const planInput = {
          libraryIds: [1],
          profileId: 'portable-v1' as const,
          includeCover: true,
          includeFanart: false,
          includeSamples: false,
          includeActorAvatars: false,
          collisionPolicy: 'replace' as const
        }
        const localPlan = (await local.nfo.plan(
          planInput,
          ipcMutation(undefined, versionsFrom(localLibrary))
        )) as NfoExportPlanPreview & { planDigest?: string }
        const remotePlan = (await remote.nfo.plan(
          planInput,
          ipcMutation(undefined, versionsFrom(remoteLibrary))
        )) as NfoExportPlanPreview & { planDigest?: string }
        assert.equal(localPlan.summary.fileCount >= 1, true, JSON.stringify(localPlan))
        assert.equal(remotePlan.summary.fileCount >= 1, true, JSON.stringify(remotePlan))
        assert.equal(Boolean(localPlan.planDigest), true)
        assert.equal(Boolean(remotePlan.planDigest), true)
      } finally {
        await remote.dispose()
        await local.dispose()
      }
    })
  })
}
