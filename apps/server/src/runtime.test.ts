import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import { buildSync } from 'esbuild'
import Database from 'better-sqlite3'
import sharp from 'sharp'
import { hashPassword } from '@http/auth'
import { closeDatabase, getDb } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { resetLibraryHostForTests } from '@library/runtime/host'
import { bindInstance } from './identity'
import { startJavdexServer, type JavdexServerHandle } from './runtime'
import type { ServerConfig } from './config'

const previousUserData = process.env.JAVDEX_TEST_USER_DATA

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('port'))
        return
      }
      const port = address.port
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

async function login(
  base: string,
  password: string,
  remember = false
): Promise<{ status: number; cookie: string; body: string }> {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
      'X-Javdex-Client': 'web'
    },
    body: JSON.stringify({ username: 'viewer', password, remember })
  })
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    body: await response.text()
  }
}

describe('server runtime lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-runtime-'))
  const workerEntry = path.join(root, 'webCatalogWorker.js')
  const staticRoot = path.join(root, 'web')
  const mediaRoot = path.join(root, 'media')
  const movie = path.join(mediaRoot, 'clip.mp4')
  const password = 'correct horse battery'
  let passwordHash = ''
  let server: JavdexServerHandle | undefined

  before(async () => {
    delete process.env.JAVDEX_TEST_USER_DATA
    fs.mkdirSync(staticRoot)
    fs.writeFileSync(path.join(staticRoot, 'index.html'), '<!doctype html><title>Javdex</title>')
    fs.mkdirSync(mediaRoot)
    fs.writeFileSync(movie, Buffer.from('0123456789abcdef'))
    passwordHash = await hashPassword(password)
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

  afterEach(async () => {
    await server?.stop()
    server = undefined
    closeDatabase()
    resetLibraryHostForTests()
    delete process.env.JAVDEX_TEST_USER_DATA
  })

  after(() => {
    if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previousUserData
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function boot(dataDir: string): Promise<{ base: string; config: ServerConfig }> {
    process.env.JAVDEX_TEST_USER_DATA = dataDir
    const config: ServerConfig = {
      listenHost: '127.0.0.1',
      port: await freePort(),
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir: path.join(dataDir, 'media_assets'),
      staticRoot,
      mediaMounts: { library: mediaRoot },
      web: { username: 'viewer', passwordHash }
    }
    server = await startJavdexServer(config, { workerEntry })
    return { base: `http://127.0.0.1:${server.port}`, config }
  }

  it('does not listen after a schema upgrade failure', async () => {
    const dataDir = path.join(root, 'upgrade-fail')
    fs.mkdirSync(dataDir, { recursive: true })
    const dbPath = path.join(dataDir, 'library.db')
    const raw = new Database(dbPath)
    raw.pragma('user_version = 99')
    raw.close()
    const port = await freePort()
    const config: ServerConfig = {
      listenHost: '127.0.0.1',
      port,
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir: path.join(dataDir, 'media_assets'),
      staticRoot,
      mediaMounts: { library: mediaRoot },
      web: { username: 'viewer', passwordHash }
    }
    await assert.rejects(
      startJavdexServer(config, { workerEntry }),
      /no longer supported/
    )
    await assert.rejects(fetch(`http://127.0.0.1:${port}/ready`))
  })

  it('refuses catalog browse until bind, then serves worker/HTTP/Range/session/images', async () => {
    assert.equal(process.versions.electron, undefined)
    const dataDir = path.join(root, 'catalog')
    const { base } = await boot(dataDir)
    const live = await fetch(`${base}/live`)
    assert.equal(live.status, 200)
    assert.deepEqual(await live.json(), { status: 'live' })
    const ready = await fetch(`${base}/ready`)
    assert.equal(ready.status, 200)
    const readyBody = await ready.text()
    assert.equal(readyBody, JSON.stringify({ ready: true }))
    assert.doesNotMatch(readyBody, /默认媒体库|library|playlist|video/i)

    const signedIn = await login(base, password, true)
    assert.equal(signedIn.status, 200)
    const collections = await fetch(`${base}/api/collections`, {
      headers: { Cookie: signedIn.cookie }
    })
    assert.equal(collections.status, 503)
    const refused = await collections.text()
    assert.match(refused, /尚未认主/)
    assert.doesNotMatch(refused, /默认媒体库/)

    bindInstance(dataDir)
    const identity = resolveMediaLibraryRootIdentity(mediaRoot)
    const timestamp = new Date().toISOString()
    const rootRow = getDb()
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
    const inserted = insertTestVideoWithFile(getDb(), {
      code: 'SRV-001',
      title: 'Server clip',
      filePath: movie,
      libraryId: 1,
      rootId: Number(rootRow.lastInsertRowid)
    })
    const png = await sharp({
      create: { width: 16, height: 10, channels: 3, background: { r: 80, g: 20, b: 20 } }
    })
      .png()
      .toBuffer()
    const coverRel = 'covers/srv-001.png'
    fs.mkdirSync(path.join(dataDir, 'media_assets', 'covers'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'media_assets', coverRel), png)
    getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRel, inserted.videoId)

    const open = await fetch(`${base}/api/collections`, { headers: { Cookie: signedIn.cookie } })
    assert.equal(open.status, 200)
    const payload = (await open.json()) as { libraries: Array<{ name: string }> }
    assert.ok(payload.libraries.some((item) => item.name === '默认媒体库'))

    const image = await fetch(`${base}/api/videos/${inserted.videoId}/images/cover`, {
      headers: { Cookie: signedIn.cookie }
    })
    assert.equal(image.status, 200)
    assert.match(image.headers.get('content-type') ?? '', /image\//)

    const ranged = await fetch(`${base}/api/videos/${inserted.videoId}/media/${inserted.fileId}`, {
      headers: { Cookie: signedIn.cookie, Range: 'bytes=0-3' }
    })
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/16')
    assert.equal(Buffer.compare(Buffer.from(await ranged.arrayBuffer()), Buffer.from('0123')), 0)

    assert.equal(getDb().pragma('journal_mode', { simple: true }), 'wal')
    const cookie = signedIn.cookie
    await server?.stop()
    server = undefined
    closeDatabase()
    resetLibraryHostForTests()

    const restarted = await boot(dataDir)
    const session = await fetch(`${restarted.base}/api/session`, { headers: { Cookie: cookie } })
    assert.equal(session.status, 200)
    const again = await fetch(`${restarted.base}/api/videos?q=SRV-001`, {
      headers: { Cookie: cookie }
    })
    assert.equal(again.status, 200)
    const page = (await again.json()) as { items: Array<{ code: string }> }
    assert.equal(page.items[0]?.code, 'SRV-001')
  })

  it('recovers interrupted scan rows before HTTP is ready', async () => {
    const dataDir = path.join(root, 'recover')
    await boot(dataDir)
    bindInstance(dataDir)
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, 1, 1, 'manual', 'running', ?)`
      )
      .run('previous-running', '2026-09-12T00:00:00.000Z')
    await server?.stop()
    server = undefined
    closeDatabase()
    resetLibraryHostForTests()

    const second = await boot(dataDir)
    const row = getDb()
      .prepare(`SELECT status, error_summary FROM library_scan_runs WHERE id = 'previous-running'`)
      .get() as { status: string; error_summary: string }
    assert.equal(row.status, 'failed')
    assert.match(row.error_summary, /中断/)
    const ready = await fetch(`${second.base}/ready`)
    assert.equal(ready.status, 200)
  })
})
