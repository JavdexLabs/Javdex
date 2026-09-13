import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { buildSync } from 'esbuild'
import { hashPassword } from '@http/auth'
import { isStructuredError } from '@shared/protocol/errors'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { ensureCatalogIdentity, readCatalogIdentity } from '@library/catalog/catalogIdentity'
import { issueCatalogMigrationToken } from '@library/catalog/catalogMigrationAuth'
import { openIsolatedCatalog } from '@library/catalog/catalogMigration'
import { SERVER_APP_VERSION } from './appVersion'
import { startJavdexServer } from './runtime'
import type { ServerConfig } from './config'

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

  function insertRoot(db: Database.Database, dir: string): number {
    const identity = resolveMediaLibraryRootIdentity(dir)
    const timestamp = new Date().toISOString()
    const row = db
      .prepare(
        `INSERT INTO media_library_roots (
           library_id, path, normalized_path, real_path, normalized_real_path,
           device_id, inode, position, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)`
      )
      .run(
        1,
        identity.path,
        identity.normalizedPath,
        identity.realPath,
        identity.normalizedRealPath,
        identity.deviceId,
        identity.inode,
        timestamp,
        timestamp
      )
    return Number(row.lastInsertRowid)
  }

  async function postManage(
    base: string,
    operation: string,
    body: unknown,
    bearer: string
  ): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${base}/manage/v1/${operation}`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'application/json',
        'X-Javdex-App-Version': SERVER_APP_VERSION,
        Authorization: `Bearer ${bearer}`
      },
      body: JSON.stringify(body)
    })
    return { status: response.status, json: await response.json() }
  }

  async function putPackage(
    base: string,
    migrationId: string,
    body: Buffer,
    bearer: string
  ): Promise<number> {
    const response = await fetch(`${base}/manage/v1/migration/packages/${migrationId}`, {
      method: 'PUT',
      headers: {
        Origin: base,
        'Content-Type': 'application/octet-stream',
        'X-Javdex-App-Version': SERVER_APP_VERSION,
        Authorization: `Bearer ${bearer}`
      },
      body: new Uint8Array(body)
    })
    return response.status
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

  describe('two Node hosts catalog migration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s13-hosts-'))
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
      fs.rmSync(root, { recursive: true, force: true })
    })

    function spawnHost(config: ServerConfig): ChildProcess {
      const child = spawn(
        process.execPath,
        ['--require', './scripts/register-test-paths.cjs', '--import', 'tsx', thisFile],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '',
            TSX_TSCONFIG_PATH: 'tsconfig.server.json',
            JAVDEX_TEST_HOST_CONFIG: JSON.stringify(config),
            JAVDEX_TEST_HOST_WORKER: workerEntry,
            JAVDEX_TEST_USER_DATA: config.dataDir
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      children.push(child)
      return child
    }

    function hostConfig(dataDir: string, mounts: Record<string, string>): ServerConfig {
      return {
        listenHost: '127.0.0.1',
        port: 0,
        accessHosts: ['127.0.0.1'],
        dataDir,
        imagesDir: path.join(dataDir, 'media_assets'),
        staticRoot,
        mediaMounts: mounts,
        web: { username: 'viewer', passwordHash }
      }
    }

    it('round-trips a catalog between two OS processes and serializes enable versus abandon', async () => {
      const sourceDir = path.join(root, 'source')
      const targetDir = path.join(root, 'target')
      const sourceMount = path.join(root, 'source-mount')
      const targetMount = path.join(root, 'target-mount')
      for (const dir of [sourceDir, targetDir, sourceMount, targetMount]) fs.mkdirSync(dir)
      fs.mkdirSync(path.join(sourceDir, 'media_assets', 'covers'), { recursive: true })
      fs.mkdirSync(path.join(targetDir, 'media_assets'), { recursive: true })
      fs.writeFileSync(
        path.join(sourceDir, 'media_assets', 'covers', 's13.png'),
        Buffer.from([0x89, 0x50, 0x4e, 0x47])
      )
      const clip = path.join(sourceMount, 'S13-001.mp4')
      fs.writeFileSync(clip, 'video')

      const sourceDb = openIsolatedCatalog(path.join(sourceDir, 'library.db'))
      const targetDb = openIsolatedCatalog(path.join(targetDir, 'library.db'))
      let sourceToken = ''
      let targetToken = ''
      let rootId = 0
      try {
        ensureCatalogIdentity({ serverId: randomUUID() }, sourceDb)
        ensureCatalogIdentity({ serverId: randomUUID() }, targetDb)
        rootId = insertRoot(sourceDb, sourceMount)
        insertTestVideoWithFile(sourceDb, {
          code: 'S13-001',
          title: 'Host clip',
          filePath: clip,
          libraryId: 1,
          rootId
        })
        sourceDb.prepare('UPDATE videos SET cover_path = ? WHERE code = ?').run('covers/s13.png', 'S13-001')
        sourceToken = issueCatalogMigrationToken({}, sourceDb).oneTimeToken
        targetToken = issueCatalogMigrationToken({}, targetDb).oneTimeToken
      } finally {
        sourceDb.close()
        targetDb.close()
      }

      const sourceChild = spawnHost(hostConfig(sourceDir, { mapped: sourceMount }))
      const targetChild = spawnHost(hostConfig(targetDir, { mapped: targetMount }))
      const sourcePort = await waitListening(sourceChild)
      const targetPort = await waitListening(targetChild)
      const sourceBase = `http://127.0.0.1:${sourcePort}`
      const targetBase = `http://127.0.0.1:${targetPort}`

      const preview = await postManage(
        sourceBase,
        'migration.preview',
        { input: { mappings: [{ sourceRootId: rootId, targetMountSelectionId: 'mapped' }] } },
        sourceToken
      )
      assert.equal(preview.status, 200, JSON.stringify(preview.json))
      const mappedBody = preview.json as { migrationId: string; digest: string }
      const started = await postManage(
        sourceBase,
        'migration.start',
        { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
        sourceToken
      )
      assert.equal(started.status, 200, JSON.stringify(started.json))
      const pkg = path.join(sourceDir, 'migration-packages', `${mappedBody.migrationId}.tar.gz`)
      assert.equal(fs.existsSync(pkg), true)
      assert.equal(
        await putPackage(targetBase, mappedBody.migrationId, fs.readFileSync(pkg), targetToken),
        200
      )
      const imported = await postManage(
        targetBase,
        'migration.start',
        { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
        targetToken
      )
      assert.equal(imported.status, 200, JSON.stringify(imported.json))

      const [enabled, abandoned] = await Promise.all([
        postManage(
          targetBase,
          'migration.enable',
          { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
          targetToken
        ),
        postManage(
          targetBase,
          'migration.abandon',
          { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
          targetToken
        )
      ])
      const status = await postManage(
        targetBase,
        'migration.status',
        { input: { migrationId: mappedBody.migrationId } },
        targetToken
      )
      assert.equal(status.status, 200, JSON.stringify({ status: status.json, enabled, abandoned }))
      const phase = (status.json as { targetPhase: string }).targetPhase
      assert.ok(phase === 'enabled' || phase === 'abandoned', phase)
      if (phase === 'enabled') {
        const live = new Database(path.join(targetDir, 'library.db'), { readonly: true, fileMustExist: true })
        try {
          const codes = live.prepare('SELECT code FROM videos').all() as Array<{ code: string }>
          assert.deepEqual(
            codes.map((row) => row.code),
            ['S13-001']
          )
          assert.equal(readCatalogIdentity(live)?.frozen, false)
          assert.equal(fs.existsSync(path.join(targetDir, 'media_assets', 'covers', 's13.png')), true)
        } finally {
          live.close()
        }
        const lateAbandon = await postManage(
          targetBase,
          'migration.abandon',
          { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
          targetToken
        )
        assert.equal(lateAbandon.status, 200)
        assert.equal((lateAbandon.json as { targetPhase: string }).targetPhase, 'enabled')
      } else {
        const lateEnable = await postManage(
          targetBase,
          'migration.enable',
          { input: { migrationId: mappedBody.migrationId, digest: mappedBody.digest } },
          targetToken
        )
        assert.equal(lateEnable.status, 401)
        assert.equal(isStructuredError(lateEnable.json) && lateEnable.json.code === 'AUTH_REQUIRED', true)
      }
    })
  })
}
