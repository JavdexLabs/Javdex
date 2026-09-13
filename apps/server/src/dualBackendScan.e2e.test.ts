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
import { waitForCatalogTask } from '../../desktop/src/main/application/catalogTaskProgress'
import { ipcMutation } from '../../desktop/src/main/application/mutationContext'
import { createLocalCatalogBackend } from '../../desktop/src/main/backends/local/localCatalogBackend'
import { createRemoteCatalogBackend } from '../../desktop/src/main/backends/remote/remoteCatalogBackend'
import { loadOrCreateLocalCatalogIdentity, localCatalogIdentityPath } from '../../desktop/src/main/desktop/localCatalogIdentity'
import { openDesktopWorkStore } from '../../desktop/src/main/desktop/workStore'
import { applyPlaylistImportThroughCatalog } from '../../desktop/src/main/services/playlistImport/playlistImportCatalogApply'
import { createMemoryPlaylistImportCatalogLookup } from '../../desktop/src/main/services/playlistImport/playlistImportCatalogLookup'
import { PlaylistImportRepository } from '../../desktop/src/main/services/playlistImport/playlistImportRepository'
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

  function catalogArtifacts(catalogPath: string): string[] {
    return [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`]
  }

  function listLibraryDbFds(catalogPath: string): string[] {
    const hits: string[] = []
    const dir = `/proc/${process.pid}/fd`
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
        fs.chmodSync(file, modes[index]!)
      })
    }
  }

  async function waitForRemoteScanAfterLateReconnect(
    remote: ReturnType<typeof createRemoteCatalogBackend>,
    taskId: string
  ): Promise<{
    snapshot: CatalogTaskSnapshot
    generationBeforeReconnect: number
    generationAfterReconnect: number
    lateSnapshot: CatalogTaskSnapshot
    applied: CatalogTaskSnapshot[]
  }> {
    const generationBeforeReconnect = remote.generation
    const lateSnapshots: CatalogTaskSnapshot[] = []
    const applied: CatalogTaskSnapshot[] = []
    const originalGet = remote.tasks.get.bind(remote.tasks)
    remote.tasks.get = async (input, ctx) => {
      const snapshot = (await originalGet(input, ctx)) as CatalogTaskSnapshot
      if (lateSnapshots.length === 0) {
        await remote.reconnect()
        lateSnapshots.push(snapshot)
      }
      return snapshot
    }
    try {
      const snapshot = await waitForCatalogTask({
        backend: remote,
        taskId,
        timeoutMs: 60_000,
        intervalMs: 50,
        onApplied: (next) => applied.push(next)
      })
      assert.equal(lateSnapshots.length, 1, 'first live tasks.get must complete before reconnect')
      const lateSnapshot = lateSnapshots[0]!
      assert.ok(
        remote.generation > generationBeforeReconnect,
        `reconnect must advance generation (${generationBeforeReconnect} -> ${remote.generation})`
      )
      assert.equal(
        applied.includes(lateSnapshot),
        false,
        'late HTTP snapshot delivered after reconnect must not be applied'
      )
      assert.equal(applied.length >= 1, true, 'a later generation poll must apply a live snapshot')
      assert.equal(
        ['succeeded', 'needsInspection'].includes(snapshot.state),
        true,
        JSON.stringify(snapshot)
      )
      return {
        snapshot,
        generationBeforeReconnect,
        generationAfterReconnect: remote.generation,
        lateSnapshot,
        applied
      }
    } finally {
      remote.tasks.get = originalGet
    }
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

    it('runs the same scan and XML NFO plan through LocalCatalogBackend and RemoteCatalogBackend', { timeout: 120_000 }, async () => {
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
        const remoteProgress = await waitForRemoteScanAfterLateReconnect(remote, remoteScan.taskId)
        const remoteTask = remoteProgress.snapshot
        assert.equal(['succeeded', 'needsInspection'].includes(remoteTask.state), true, JSON.stringify(remoteTask))

        const localLatest = (await local.libraries.latestScan({ libraryId: 1 })) as LibraryScanLatestSnapshot
        const remoteLatest = (await remote.libraries.latestScan({ libraryId: 1 })) as LibraryScanLatestSnapshot
        assert.equal(localLatest.summary?.status, 'success', JSON.stringify(localLatest))
        assert.equal(remoteLatest.summary?.status, 'success', JSON.stringify(remoteLatest))
        assert.equal((localLatest.summary?.scannedFiles ?? 0) >= 1, true, JSON.stringify(localLatest))
        assert.equal((remoteLatest.summary?.scannedFiles ?? 0) >= 1, true, JSON.stringify(remoteLatest))

        const localHeader = (await local.libraries.auditHeader({ libraryId: 1 })) as {
          snapshot: { runId: string } | null
        }
        const remoteHeader = (await remote.libraries.auditHeader({ libraryId: 1 })) as {
          snapshot: { runId: string } | null
        }
        assert.equal(Boolean(localHeader.snapshot?.runId), true, JSON.stringify(localHeader))
        assert.equal(Boolean(remoteHeader.snapshot?.runId), true, JSON.stringify(remoteHeader))
        const localAuditPage = (await local.libraries.auditPage({
          libraryId: 1,
          section: 'files',
          limit: 50,
          offset: 0
        })) as { total: number }
        const remoteAuditPage = (await remote.libraries.auditPage({
          libraryId: 1,
          section: 'files',
          attention: true,
          limit: 50,
          offset: 0
        })) as { total: number }
        assert.equal(localAuditPage.total >= 1, true, JSON.stringify(localAuditPage))
        assert.equal(remoteAuditPage.total >= 1, true, JSON.stringify(remoteAuditPage))
        const localAuditView = (await local.libraries.auditViewPage({
          libraryId: 1,
          tab: 'all',
          limit: 50,
          offset: 0
        })) as { auditAvailable: boolean; total: number }
        const remoteAuditView = (await remote.libraries.auditViewPage({
          libraryId: 1,
          tab: 'all',
          limit: 50,
          offset: 0
        })) as { auditAvailable: boolean; total: number }
        assert.equal(localAuditView.auditAvailable, true, JSON.stringify(localAuditView))
        assert.equal(remoteAuditView.auditAvailable, true, JSON.stringify(remoteAuditView))
        assert.equal(localAuditView.total >= 1, true, JSON.stringify(localAuditView))
        assert.equal(remoteAuditView.total >= 1, true, JSON.stringify(remoteAuditView))

        const presenceInput = {
          libraryId: 1,
          groupIds: [999_001],
          identityIds: [999_002],
          scrapeIds: [999_003]
        }
        const localPresence = await local.libraries.pendingAuditPresence(presenceInput)
        const remotePresence = await remote.libraries.pendingAuditPresence(presenceInput)
        assert.deepEqual(localPresence, { groupIds: [], identityIds: [], scrapeIds: [] })
        assert.deepEqual(remotePresence, localPresence)

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

        await local.dispose()
        closeDatabase()
        const localCatalogPath = path.join(localDir, 'library.db')
        const restoreCatalog = chmodCatalogClosed(localCatalogPath)
        try {
          assert.throws(() => getDb(), /Database not initialised/)
          assert.deepEqual(listLibraryDbFds(localCatalogPath), [])
          const lookup = createMemoryPlaylistImportCatalogLookup()
          await lookup.ingestCodes(remote, ['ABC-001'])
          const matched = lookup.videosByCode('ABC-001')
          assert.equal(matched.length, 1, JSON.stringify(matched))
          const videoId = matched[0]!.videoId
          const work = openDesktopWorkStore(path.join(localDir, 'desktop-work.db'))
          try {
            const repository = new PlaylistImportRepository(work.database(), lookup)
            repository.createJob({
              runId: 'run-remote-http-apply',
              idempotencyKey: 'remote-http-apply',
              sourceUrl: 'https://example.test/list',
              targetLibraryId: 1,
              destination: { kind: 'create', requestedName: '远程导入清单' },
              targetLibrary: { id: 1, name: remoteLibrary.name },
              autoCreateUnmatchedVideos: false
            })
            const preview = repository.checkpointStaticPage({
              runId: 'run-remote-http-apply',
              pageKey: 'page-0',
              pageOrder: 0,
              pageUrl: 'https://example.test/list',
              documentRevision: '1:1',
              viewRevision: '1:1:0',
              evidenceRef: 'evidence',
              items: [{ code: 'ABC-001', detailUrl: 'https://example.test/video/abc-001' }],
              nextPageUrls: [],
              terminal: true
            })
            assert.equal(preview.phase, 'ready-to-apply', JSON.stringify(preview))
            const outcome = await applyPlaylistImportThroughCatalog(
              remote,
              repository,
              'run-remote-http-apply',
              'apply-http-1'
            )
            assert.equal(outcome.playlistId > 0, true, JSON.stringify(outcome))
            assert.equal(outcome.reusedVideos, 1)
            assert.equal(outcome.createdVideos, 0)
            const created = (await remote.playlists.get({ playlistId: outcome.playlistId })) as {
              name?: string
              videos?: Array<{ id: number; code?: string }>
            } | null
            assert.equal(created?.name, '远程导入清单', JSON.stringify(created))
            assert.equal(
              created?.videos?.some((video) => video.id === videoId || video.code === 'ABC-001'),
              true,
              JSON.stringify(created)
            )
            assert.equal(repository.snapshot('run-remote-http-apply')?.phase, 'completed')
            assert.throws(() => getDb(), /Database not initialised/)
            assert.deepEqual(listLibraryDbFds(localCatalogPath), [])
          } finally {
            work.close()
          }
        } finally {
          restoreCatalog()
        }
      } finally {
        await remote.dispose()
        await local.dispose()
      }
    })
  })
}
