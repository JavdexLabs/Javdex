import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
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
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import { isStructuredError } from '@shared/protocol/errors'
import { issueDeployToken, issueMigrationToken } from './identity'
import { dispatchManageOperation } from './manageDispatch'
import { startJavdexServer, type JavdexServerHandle } from './runtime'
import type { ServerConfig } from './config'
import { SERVER_APP_VERSION } from './appVersion'
import { createHash, randomUUID } from 'node:crypto'
import { createRemoteCatalogBackend } from '../../desktop/src/main/backends/remote/remoteCatalogBackend'
import { createLocalCatalogBackend } from '../../desktop/src/main/backends/local/localCatalogBackend'
import { upsertActressFromScrape } from '@library/db/actressRepo'
import { filesRenameDigest } from '@library/catalog/catalogFileMaintenance'
import { previewLibraryPathRemoval } from '@library/scan/libraryPathCleanupService'
import { JAVDEX_ROOT_MARKER } from '@library/scan/javdexRootMarker'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  getPendingVideoScrapeById,
  replacePendingVideoScrape
} from '@library/db/pendingVideoScrapeRepo'
import { targetListFilterDigest } from '@library/catalog/catalogTargetLists'
import { inspectPlayStream, resourceLocatorRevision } from '@library/catalog/catalogPlay'
import { PLAY_GRANT_TTL_MS } from '@shared/protocol/limits'
import { AgentMetadataDraftRepo } from '@library/db/agentMetadataDraftRepo'

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

async function postManage(
  base: string,
  operation: string,
  body: unknown,
  options: { bearer?: string; cookie?: string; appVersion?: string } = {}
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Origin: base,
    'Content-Type': 'application/json'
  }
  if (options.appVersion !== '') {
    headers['X-Javdex-App-Version'] = options.appVersion ?? SERVER_APP_VERSION
  }
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
  if (options.cookie) headers.Cookie = options.cookie
  const response = await fetch(`${base}/manage/v1/${operation}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  })
  return { status: response.status, json: await response.json() }
}

async function claimInitialWriter(
  base: string,
  config: ServerConfig
): Promise<{ secret: string; serverId: string; catalogId: string; writerEpoch: number }> {
  const handshake = await postManage(base, 'handshake.get', { input: {} }, { appVersion: '' })
  assert.equal(handshake.status, 200)
  const result = handshake.json as {
    ready: string
    identity: { serverId: string; catalogId: string }
    writerEpoch: number
  }
  assert.equal(result.ready, 'notBound')
  const issued = issueDeployToken(config, 'initialBind')
  const secret = generateSecret()
  const claim = await postManage(base, 'writer.claim', {
    serverId: result.identity.serverId,
    catalogId: result.identity.catalogId,
    input: {
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) }
    }
  })
  assert.equal(claim.status, 200)
  const claimed = claim.json as { status: string; writerEpoch: number; bound: boolean }
  assert.equal(claimed.status, 'consumed')
  assert.equal(claimed.bound, true)
  return {
    secret,
    serverId: result.identity.serverId,
    catalogId: result.identity.catalogId,
    writerEpoch: claimed.writerEpoch
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

  async function boot(
    dataDir: string,
    extraMounts: Record<string, string> = {}
  ): Promise<{ base: string; config: ServerConfig }> {
    process.env.JAVDEX_TEST_USER_DATA = dataDir
    const config: ServerConfig = {
      listenHost: '127.0.0.1',
      port: await freePort(),
      accessHosts: ['127.0.0.1'],
      dataDir,
      imagesDir: path.join(dataDir, 'media_assets'),
      staticRoot,
      mediaMounts: { library: mediaRoot, ...extraMounts },
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
    const { base, config } = await boot(dataDir)
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

    const writer = await claimInitialWriter(base, config)
    const cookieManage = await postManage(
      base,
      'writer.status',
      { serverId: writer.serverId, catalogId: writer.catalogId, input: {} },
      { cookie: signedIn.cookie }
    )
    assert.equal(cookieManage.status, 401)
    assert.throws(
      () =>
        dispatchManageOperation(
          {
            operation: 'writer.recoverIssue',
            body: { input: {} },
            bearerSecret: null,
            remoteAddress: '192.168.1.10',
            isLoopback: false,
            host: null
          },
          getDb()
        ),
      (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'
    )

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

    const version = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(inserted.videoId) as { generation: number; revision: number }
    const edited = await postManage(
      base,
      'videos.edit',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: { videoId: inserted.videoId, fields: { title: 'Edited clip' } }
      },
      { bearer: writer.secret }
    )
    assert.equal(edited.status, 200)
    const editedBody = edited.json as { versions: { V: { revision: number } } }
    assert.equal(editedBody.versions.V.revision, version.revision + 1)
    const stale = await postManage(
      base,
      'videos.edit',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: { videoId: inserted.videoId, fields: { title: 'Stale' } }
      },
      { bearer: writer.secret }
    )
    assert.equal(stale.status, 409)
    assert.equal((stale.json as { code: string }).code, 'VERSION_CONFLICT')

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

  async function putUpload(
    base: string,
    uploadId: string,
    body: Buffer,
    options: { bearer?: string; cookie?: string; contentType?: string; appVersion?: string } = {}
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      Origin: base,
      'Content-Type': options.contentType ?? 'image/png'
    }
    if (options.appVersion !== '') {
      headers['X-Javdex-App-Version'] = options.appVersion ?? SERVER_APP_VERSION
    }
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`
    if (options.cookie) headers.Cookie = options.cookie
    const response = await fetch(`${base}/manage/v1/uploads/${uploadId}`, {
      method: 'PUT',
      headers,
      body
    })
    return { status: response.status, json: await response.json() }
  }

  async function insertBoundVideo(
    code: string,
    filePath = movie
  ): Promise<{ videoId: number; fileId: number }> {
    const identity = resolveMediaLibraryRootIdentity(mediaRoot)
    const existing = getDb()
      .prepare('SELECT id FROM media_library_roots WHERE normalized_path = ?')
      .get(identity.normalizedPath) as { id: number } | undefined
    let rootId = existing?.id
    if (rootId == null) {
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
      rootId = Number(rootRow.lastInsertRowid)
    }
    const inserted = insertTestVideoWithFile(getDb(), {
      code,
      title: code,
      filePath,
      libraryId: 1,
      rootId
    })
    return { videoId: inserted.videoId, fileId: inserted.fileId }
  }

  it('uploads an image, applies it as cover, and keeps the formal file after restart', async () => {
    const dataDir = path.join(root, 'upload-cover')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId } = await insertBoundVideo('S06-HTTP')
    const version = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(videoId) as { generation: number; revision: number }
    const created = await postManage(
      base,
      'uploads.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { purpose: 'videoCover', contentType: 'image/png' }
      },
      { bearer: writer.secret }
    )
    assert.equal(created.status, 200)
    const uploadId = (created.json as { uploadId: string }).uploadId
    const png = await sharp({
      create: { width: 14, height: 9, channels: 3, background: { r: 30, g: 60, b: 90 } }
    })
      .png()
      .toBuffer()
    const put = await putUpload(base, uploadId, png, { bearer: writer.secret })
    assert.equal(put.status, 200)
    assert.equal((put.json as { consumed: boolean }).consumed, false)
    const inspected = await postManage(
      base,
      'uploads.inspect',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input: { uploadId }
      },
      { bearer: writer.secret }
    )
    assert.equal(inspected.status, 200)
    const applied = await postManage(
      base,
      'videos.setPoster',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: { videoId, image: { kind: 'upload', uploadId } }
      },
      { bearer: writer.secret }
    )
    assert.equal(applied.status, 200)
    const coverRel = (getDb().prepare('SELECT cover_path FROM videos WHERE id = ?').get(videoId) as { cover_path: string })
      .cover_path
    assert.ok(coverRel?.startsWith('covers/'))
    const coverAbs = path.join(dataDir, 'media_assets', coverRel)
    assert.equal(fs.existsSync(coverAbs), true)
    const cookie = (await login(base, password, true)).cookie
    const cookiePut = await putUpload(base, uploadId, png, { cookie })
    assert.equal(cookiePut.status, 401)
    await server?.stop()
    server = undefined
    closeDatabase()
    resetLibraryHostForTests()
    const restarted = await boot(dataDir)
    assert.equal(fs.existsSync(coverAbs), true)
    const cover = await fetch(`${restarted.base}/api/videos/${videoId}/images/cover`, {
      headers: { Cookie: cookie }
    })
    assert.equal(cover.status, 200)
  })

  it('rejects desktop paths, unknown fields, and foreign sample asset ids', async () => {
    const dataDir = path.join(root, 'upload-boundary')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const otherFile = path.join(mediaRoot, 'clip-b.mp4')
    fs.writeFileSync(otherFile, Buffer.from('other-file-bytes'))
    const first = await insertBoundVideo('S06-A')
    const second = await insertBoundVideo('S06-B', otherFile)
    const version = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(first.videoId) as { generation: number; revision: number }
    const desktopPath = await postManage(
      base,
      'videos.setPoster',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: { videoId: first.videoId, posterPath: 'C:\\covers\\a.jpg' }
      },
      { bearer: writer.secret }
    )
    assert.equal(desktopPath.status, 400)
    const coverSource = await postManage(
      base,
      'videos.edit',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: {
          videoId: first.videoId,
          fields: { coverSourcePath: '/tmp/secret.jpg' }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(coverSource.status, 400)
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } }
    })
      .png()
      .toBuffer()
    const sampleRel = 'samples/foreign.png'
    fs.mkdirSync(path.join(dataDir, 'media_assets', 'samples'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'media_assets', sampleRel), png)
    const foreign = getDb()
      .prepare(
        "INSERT INTO video_assets (video_id, type, local_path) VALUES (?, 'sample', ?)"
      )
      .run(second.videoId, sampleRel)
    const foreignApply = await postManage(
      base,
      'videos.setPoster',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: version },
        input: { videoId: first.videoId, image: { kind: 'asset', assetId: Number(foreign.lastInsertRowid) } }
      },
      { bearer: writer.secret }
    )
    assert.equal(foreignApply.status, 400)
    const cover = getDb()
      .prepare('SELECT cover_path, poster_path FROM videos WHERE id = ?')
      .get(first.videoId) as { cover_path: string | null; poster_path: string | null }
    assert.equal(cover.cover_path, null)
    assert.equal(cover.poster_path, null)
  })

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

  it('does not import the catalog database from RemoteCatalogBackend', () => {
    const source = fs.readFileSync(
      path.resolve('apps/desktop/src/main/backends/remote/remoteCatalogBackend.ts'),
      'utf8'
    )
    assert.equal(source.includes('@library/db'), false)
    assert.equal(source.includes('initDatabase'), false)
    assert.equal(source.includes('getDb'), false)
    assert.equal(source.includes("from 'electron'"), false)
  })

  it('edits a title and cover through RemoteCatalogBackend without a second local catalog', async () => {
    const dataDir = path.join(root, 'remote-backend')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId } = await insertBoundVideo('S07-REMOTE')
    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    try {
      assert.equal(backend.mode, 'remote')
      const detail = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string; generation: number; revision: number; cover_path: string | null }
      assert.equal(detail.title, 'S07-REMOTE')
      const operationId = randomUUID()
      const edited = await backend.videos.edit(
        { videoId, fields: { title: 'Remote After' } },
        {
          operationId,
          expectedVersions: { V: { generation: detail.generation, revision: detail.revision } }
        }
      )
      assert.equal(edited, true)
      const retry = await backend.videos.edit(
        { videoId, fields: { title: 'Remote After' } },
        {
          operationId,
          expectedVersions: { V: { generation: detail.generation, revision: detail.revision } }
        }
      )
      assert.equal(retry, true)
      const afterEdit = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string; revision: number; generation: number }
      assert.equal(afterEdit.title, 'Remote After')
      assert.equal(afterEdit.revision, detail.revision + 1)

      const created = (await backend.assets.createUpload(
        { purpose: 'videoCover', contentType: 'image/png' },
        { operationId: randomUUID(), expectedVersions: {} }
      )) as { uploadId: string }
      const png = await sharp({
        create: { width: 12, height: 8, channels: 3, background: { r: 9, g: 18, b: 27 } }
      })
        .png()
        .toBuffer()
      const uploaded = (await backend.assets.putUpload({
        uploadId: created.uploadId,
        body: png,
        contentType: 'image/png'
      })) as { consumed: boolean }
      assert.equal(uploaded.consumed, false)
      await backend.videos.setPoster(
        { videoId, image: { kind: 'upload', uploadId: created.uploadId } },
        {
          operationId: randomUUID(),
          expectedVersions: { V: { generation: afterEdit.generation, revision: afterEdit.revision } }
        }
      )
      const covered = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { cover_path: string | null; title: string }
      assert.equal(covered.title, 'Remote After')
      assert.ok(covered.cover_path?.startsWith('covers/'))
      assert.equal(fs.existsSync(path.join(dataDir, 'media_assets', covered.cover_path!)), true)
      assert.equal(backend.session().state, 'available')
      assert.equal(backend.capabilities().editCatalog.allowed, true)
      assert.equal(backend.capabilities().playLocalFile.allowed, false)
    } finally {
      await backend.dispose()
    }
  })

  it('marks versionMismatch when the desktop app version does not match the server', async () => {
    const dataDir = path.join(root, 'remote-version')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: '0.0.0-test',
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    })
    try {
      await assert.rejects(
        () => backend.queries.getVideo({ scope: { kind: 'all' }, videoId: 1 }),
        (error: unknown) => isStructuredError(error) && error.code === 'VERSION_MISMATCH'
      )
      assert.equal(backend.session().state, 'versionMismatch')
    } finally {
      await backend.dispose()
    }
  })

  it('lets manage read hidden videos and archived libraries that web cannot', async () => {
    const dataDir = path.join(root, 'm01-scope')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId } = await insertBoundVideo('M01-HIDDEN')
    getDb()
      .prepare('UPDATE library_video_memberships SET is_hidden = 1 WHERE video_id = ?')
      .run(videoId)
    const archivedId = Number(
      getDb()
        .prepare("INSERT INTO media_libraries (name, status, position) VALUES ('Archived Box', 'archived', 8)")
        .run().lastInsertRowid
    )
    getDb().prepare('INSERT INTO media_library_configs (library_id) VALUES (?)').run(archivedId)

    const cookie = (await login(base, password, true)).cookie
    const webDetail = await fetch(`${base}/api/videos/${videoId}`, { headers: { Cookie: cookie } })
    assert.equal(webDetail.status, 404)
    const webBrowse = await fetch(`${base}/api/videos?q=M01-HIDDEN`, { headers: { Cookie: cookie } })
    assert.equal(webBrowse.status, 200)
    const browseBody = (await webBrowse.json()) as { items?: Array<{ id: number }> }
    assert.equal((browseBody.items ?? []).some((item) => item.id === videoId), false)
    const collections = await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })
    assert.equal(collections.status, 200)
    const collectionBody = (await collections.json()) as { libraries: Array<{ id: number; name: string }> }
    assert.equal(collectionBody.libraries.some((library) => library.id === archivedId), false)

    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    })
    try {
      const detail = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { id: number; title: string }
      assert.equal(detail.id, videoId)
      assert.equal(detail.title, 'M01-HIDDEN')
      const libraries = (await backend.libraries.list({ includeArchived: true })) as Array<{
        id: number
        status: string
      }>
      assert.equal(libraries.some((library) => library.id === archivedId && library.status === 'archived'), true)
    } finally {
      await backend.dispose()
    }
  })

  it('redeems a one-time token through RemoteCatalogBackend without exposing the writer secret', async () => {
    const dataDir = path.join(root, 'remote-claim')
    const { base, config } = await boot(dataDir)
    const handshake = await postManage(base, 'handshake.get', { input: {} }, { appVersion: '' })
    const hello = handshake.json as { identity: { serverId: string; catalogId: string } }
    const issued = issueDeployToken(config, 'initialBind')
    const credentials = memoryCredentials(new Map())
    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    try {
      const claimed = await backend.claimWriter({
        kind: 'initialBind',
        oneTimeToken: issued.oneTimeToken
      })
      assert.equal(claimed.bound, true)
      assert.equal(claimed.status, 'consumed')
      assert.equal(await credentials.readWriterSecret(hello.identity.catalogId) != null, true)
      assert.equal(JSON.stringify(claimed).includes(issued.oneTimeToken), false)
      assert.equal(backend.session().state, 'available')
      const status = JSON.stringify(backend.session())
      assert.equal(status.includes('secret'), false)
    } finally {
      await backend.dispose()
    }
  })

  it('serves S08 browse/edit on the real Node host for both local and remote backends', async () => {
    const dataDir = path.join(root, 's08-browse-edit')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId, fileId } = await insertBoundVideo('S08-LOOP')
    getDb().prepare('UPDATE videos SET release_date = ? WHERE id = ?').run('2024-03-01', videoId)
    const independentId = upsertActressFromScrape('Independent Star', null, 'female')
    const version = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(videoId) as { generation: number; revision: number }
    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const remote = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    const local = createLocalCatalogBackend({
      identity: { mode: 'local', catalogId: writer.catalogId }
    })
    const ctx = { operationId: randomUUID(), expectedVersions: { V: version } }
    try {
      const remoteSearch = (await remote.queries.homeSearch({ search: 'S08-LOOP' })) as {
        items: Array<{ id: number; title: string | null }>
      }
      const localSearch = (await local.queries.homeSearch({ search: 'S08-LOOP' })) as {
        items: Array<{ id: number; title: string | null }>
      }
      assert.equal(remoteSearch.items.some((item) => item.id === videoId), true)
      assert.equal(localSearch.items.some((item) => item.id === videoId), true)

      const remoteYears = (await remote.queries.listVideoYears({ scope: { kind: 'all' } })) as number[]
      const localYears = (await local.queries.listVideoYears({ scope: { kind: 'all' } })) as number[]
      assert.equal(remoteYears.includes(2024), true)
      assert.deepEqual(remoteYears, localYears)

      const remoteResource = (await remote.queries.getResource({
        libraryId: 1,
        videoId,
        resourceId: fileId
      })) as { id: number; video_id: number }
      const localResource = (await local.queries.getResource({
        libraryId: 1,
        videoId,
        resourceId: fileId
      })) as { id: number; video_id: number }
      assert.equal(remoteResource.id, fileId)
      assert.equal(localResource.id, fileId)
      assert.equal(remoteResource.video_id, videoId)

      const rated = await remote.videos.setRating({ videoId, rating: 4 }, ctx)
      assert.equal(rated, true)
      const remoteDetail = (await remote.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { rating: number; title: string }
      const localDetail = (await local.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { rating: number; title: string }
      assert.equal(remoteDetail.rating, 4)
      assert.equal(localDetail.rating, 4)
      const afterRating = getDb()
        .prepare('SELECT generation, revision FROM videos WHERE id = ?')
        .get(videoId) as { generation: number; revision: number }
      assert.deepEqual(afterRating, version)

      const titled = await remote.videos.edit(
        { videoId, fields: { title: 'Rated then titled' } },
        { operationId: randomUUID(), expectedVersions: { V: version } }
      )
      assert.equal(titled, true)
      const afterTitle = (await remote.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string; revision: number }
      assert.equal(afterTitle.title, 'Rated then titled')
      assert.equal(afterTitle.revision, version.revision + 1)

      await remote.videos.addManualTag({ videoId, name: 's08-manual' }, {
        operationId: randomUUID(),
        expectedVersions: { V: { generation: version.generation, revision: afterTitle.revision } }
      })
      const manuals = (await remote.queries.listManualTags({})) as Array<{ name: string }>
      const localManuals = (await local.queries.listManualTags({})) as Array<{ name: string }>
      assert.equal(manuals.some((tag) => tag.name === 's08-manual'), true)
      assert.equal(localManuals.some((tag) => tag.name === 's08-manual'), true)

      const actresses = (await remote.actresses.list({ gender: 'female' })) as Array<{
        id: number
        main_name: string
      }>
      const localActresses = (await local.actresses.list({ gender: 'female' })) as Array<{
        id: number
        main_name: string
      }>
      assert.equal(actresses.some((row) => row.id === independentId && row.main_name === 'Independent Star'), true)
      assert.equal(
        localActresses.some((row) => row.id === independentId && row.main_name === 'Independent Star'),
        true
      )

      const orgId = (await remote.classifications.createOrganization(
        { role: 'maker', mainName: 'S08 Studio' },
        { operationId: randomUUID(), expectedVersions: {} }
      )) as number
      assert.equal(typeof orgId, 'number')
      const orgs = (await remote.classifications.listOrganizations({ role: 'maker' })) as Array<{
        id: number
        mainName: string
      }>
      const localOrgs = (await local.classifications.listOrganizations({ role: 'maker' })) as Array<{
        id: number
        mainName: string
      }>
      assert.equal(orgs.some((row) => row.id === orgId && row.mainName === 'S08 Studio'), true)
      assert.equal(localOrgs.some((row) => row.id === orgId && row.mainName === 'S08 Studio'), true)

      const playlist = (await remote.playlists.create(
        { name: 'S08 List' },
        { operationId: randomUUID(), expectedVersions: {} }
      )) as { playlistId: number }
      const added = await remote.playlists.addVideo(
        { playlistId: playlist.playlistId, videoId },
        {
          operationId: randomUUID(),
          expectedVersions: {
            P: getDb()
              .prepare('SELECT generation, revision FROM playlists WHERE id = ?')
              .get(playlist.playlistId) as { generation: number; revision: number }
          }
        }
      )
      assert.equal(added, true)
      const memberships = (await remote.playlists.listForVideo({ videoId })) as Array<{
        id: number
        contains_video: boolean
      }>
      const localMemberships = (await local.playlists.listForVideo({ videoId })) as Array<{
        id: number
        contains_video: boolean
      }>
      assert.equal(memberships.some((row) => row.id === playlist.playlistId && row.contains_video), true)
      assert.equal(
        localMemberships.some((row) => row.id === playlist.playlistId && row.contains_video),
        true
      )

      const library = (await remote.libraries.get({ libraryId: 1 })) as { id: number; name: string }
      const localLibrary = (await local.libraries.get({ libraryId: 1 })) as { id: number; name: string }
      assert.equal(library.id, 1)
      assert.equal(localLibrary.id, 1)
      assert.equal(library.name, localLibrary.name)

      const imported = (await remote.videos.importResource(
        {
          libraryId: 1,
          code: 'S08-LINK',
          target: { kind: 'new' },
          url: 'https://example.test/s08-link',
          kind: 'web',
          displayName: 'S08 link'
        },
        { operationId: randomUUID(), expectedVersions: {} }
      )) as { videoId: number; createdVideo: boolean }
      assert.equal(imported.createdVideo, true)
      const localImported = (await local.queries.getVideo({
        scope: { kind: 'all' },
        videoId: imported.videoId
      })) as { code: string }
      assert.equal(localImported.code, 'S08-LINK')

      const preview = (await remote.videos.previewDeleteGlobal({ videoId: imported.videoId })) as {
        revision: string
        videoId: number
      }
      assert.equal(preview.videoId, imported.videoId)
      assert.match(preview.revision, /^[a-f0-9]{64}$/)

      const directorId = (await remote.classifications.createDirector(
        { mainName: 'S08 Director' },
        { operationId: randomUUID(), expectedVersions: {} }
      )) as number
      const directorPreview = (await remote.classifications.directorDeletePreview({
        directorId
      })) as { id: number; planDigest: string }
      assert.equal(directorPreview.id, directorId)
      assert.match(directorPreview.planDigest, /^[a-f0-9]{64}$/)
      const directorVersion = getDb()
        .prepare('SELECT generation, revision FROM directors WHERE id = ?')
        .get(directorId) as { generation: number; revision: number }
      await remote.classifications.deleteDirector(
        { directorId, planId: randomUUID(), planDigest: directorPreview.planDigest },
        { operationId: randomUUID(), expectedVersions: { F: directorVersion } }
      )
      assert.equal(await remote.classifications.getDirector({ directorId }), null)

      const inspect = (await remote.actresses.inspectName({
        actressId: independentId,
        name: 'Unused Conflict Name'
      })) as { status: string }
      const localInspect = (await local.actresses.inspectName({
        actressId: independentId,
        name: 'Unused Conflict Name'
      })) as { status: string }
      assert.equal(inspect.status, 'available')
      assert.equal(localInspect.status, 'available')

      const pendingCount = await postManage(
        base,
        'pendingVideoScrapes.count',
        { serverId: writer.serverId, catalogId: writer.catalogId, input: {} },
        { bearer: writer.secret }
      )
      assert.equal(pendingCount.status, 200)
      assert.equal(pendingCount.json, 0)
      const pendingScan = await postManage(
        base,
        'pendingScan.list',
        { serverId: writer.serverId, catalogId: writer.catalogId, input: {} },
        { bearer: writer.secret }
      )
      assert.equal(pendingScan.status, 200)
      assert.equal(Array.isArray(pendingScan.json), true)

      const browserOn = (await remote.browser.status({})) as { enabled?: boolean; pairingUntil?: number }
      assert.equal(browserOn.enabled, true)
      await remote.browser.setEnabled(
        { enabled: false },
        { operationId: randomUUID(), expectedVersions: {} }
      )
      const helloOff = await postManage(base, 'handshake.get', { input: {} }, { appVersion: '' })
      assert.equal(helloOff.status, 200)
      assert.equal(
        (helloOff.json as { capabilities?: { browserEnabled?: boolean } }).capabilities?.browserEnabled,
        false
      )
      const loginOff = await login(base, password, true)
      assert.equal(loginOff.status, 404)
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(dataDir, 'browser-surface.json'), 'utf8')).enabled,
        false
      )
      const manageWhileOff = await postManage(
        base,
        'home.search',
        { serverId: writer.serverId, catalogId: writer.catalogId, input: { search: 'S08-LOOP' } },
        { bearer: writer.secret }
      )
      assert.equal(manageWhileOff.status, 200)
      await remote.browser.setEnabled(
        { enabled: true },
        { operationId: randomUUID(), expectedVersions: {} }
      )
      const opened = (await remote.browser.pairOpen(
        {},
        { operationId: randomUUID(), expectedVersions: {} }
      )) as { pairingUntil?: number }
      assert.equal(typeof opened.pairingUntil, 'number')
      assert.ok((opened.pairingUntil ?? 0) > Date.now())

      const cookie = (await login(base, password, true)).cookie
      const cookieSearch = await postManage(
        base,
        'home.search',
        { serverId: writer.serverId, catalogId: writer.catalogId, input: { search: 'S08-LOOP' } },
        { cookie }
      )
      assert.equal(cookieSearch.status, 401)
    } finally {
      await remote.dispose()
      await local.dispose()
    }
  })

  it('scans a real mount, writes XML-only NFO, and keeps marker vs unmount distinct', async () => {
    const s09Mount = path.join(root, 's09-media')
    const extraMount = path.join(root, 's09-unmount')
    fs.mkdirSync(s09Mount, { recursive: true })
    fs.mkdirSync(extraMount, { recursive: true })
    const videoPath = path.join(s09Mount, 'ABC-001.mp4')
    fs.writeFileSync(videoPath, Buffer.from('0123456789abcdef'))
    const dataDir = path.join(root, 's09-scan-nfo')
    const { base, config } = await boot(dataDir, { s09: s09Mount, extra: extraMount })
    const writer = await claimInitialWriter(base, config)

    const versions = (library: { revision: number; config: { revision: number } }) => ({
      L: { generation: 1, revision: library.revision },
      C: { generation: 1, revision: library.config.revision },
      G: { generation: 1, revision: 1 },
      V: { generation: 1, revision: 1 },
      R: { generation: 1, revision: 1 }
    })
    const envelope = (operationId: string, expectedVersions: unknown, input: unknown) => ({
      operationId,
      serverId: writer.serverId,
      catalogId: writer.catalogId,
      writerEpoch: writer.writerEpoch,
      expectedVersions,
      input
    })
    const query = (input: unknown) => ({
      serverId: writer.serverId,
      catalogId: writer.catalogId,
      writerEpoch: writer.writerEpoch,
      input
    })
    const write = async (operation: string, expectedVersions: unknown, input: unknown) =>
      postManage(base, operation, envelope(randomUUID(), expectedVersions, input), { bearer: writer.secret })
    const read = async (operation: string, input: unknown) =>
      postManage(base, operation, query(input), { bearer: writer.secret })

    const pollTask = async (taskId: string, timeoutMs = 60000) => {
      const startedAt = Date.now()
      let last: { state: string; counts?: Record<string, number>; label?: string } | undefined
      while (Date.now() - startedAt < timeoutMs) {
        const result = await read('tasks.get', { taskId })
        assert.equal(result.status, 200)
        last = result.json as { state: string; counts?: Record<string, number>; label?: string }
        if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
    }

    let library = (await read('libraries.get', { libraryId: 1 })).json as {
      revision: number
      config: { revision: number }
      roots: Array<{ id: number; path: string }>
    }
    const configUpdated = await write('libraries.updateConfig', versions(library), {
      libraryId: 1,
      patch: { minImportDurationMinutes: 0 }
    })
    assert.equal(configUpdated.status, 200)
    library = (await read('libraries.get', { libraryId: 1 })).json as typeof library

    const added = await write('libraries.addRoot', versions(library), {
      libraryId: 1,
      root: { mountSelectionId: 's09' }
    })
    assert.equal(added.status, 200, JSON.stringify(added.json))
    const addedRoot = added.json as { id: number; path: string }
    assert.equal(fs.existsSync(path.join(s09Mount, JAVDEX_ROOT_MARKER)), true)
    assert.equal(
      (
        getDb()
          .prepare('SELECT 1 AS ok FROM catalog_root_markers WHERE library_id = 1 AND root_id = ?')
          .get(addedRoot.id) as { ok: number } | undefined
      )?.ok,
      1
    )

    const hostPath = await write('libraries.addRoot', versions(library), {
      libraryId: 1,
      root: { path: s09Mount }
    })
    assert.equal(hostPath.status, 400)
    assert.equal((hostPath.json as { code?: string }).code, 'INVALID_INPUT')

    library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
    const scanOp = randomUUID()
    const started = await postManage(
      base,
      'scans.run',
      envelope(scanOp, versions(library), { libraryId: 1 }),
      { bearer: writer.secret }
    )
    assert.equal(started.status, 200, JSON.stringify(started.json))
    const startedBody = started.json as { taskId: string; receipt: { status: string } }
    assert.equal(startedBody.receipt.status, 'acceptedTask')
    const duplicate = await postManage(
      base,
      'scans.run',
      envelope(scanOp, versions(library), { libraryId: 1 }),
      { bearer: writer.secret }
    )
    assert.equal(duplicate.status, 200)
    assert.equal((duplicate.json as { taskId: string }).taskId, startedBody.taskId)

    const finished = await pollTask(startedBody.taskId)
    assert.equal(finished.state, 'succeeded', JSON.stringify(finished))
    const video = getDb()
      .prepare("SELECT id, code, generation, revision FROM videos WHERE code = 'ABC-001'")
      .get() as { id: number; code: string; generation: number; revision: number } | undefined
    assert.equal(video?.code, 'ABC-001')
    const afterFirstScan = { generation: video!.generation, revision: video!.revision }

    for (let index = 0; index < 80; index += 1) {
      fs.writeFileSync(path.join(s09Mount, `ZZZ-${String(index).padStart(3, '0')}.mp4`), 'x')
    }
    library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
    const busyScan = await write('scans.run', versions(library), { libraryId: 1 })
    assert.equal(busyScan.status, 200, JSON.stringify(busyScan.json))
    const busyId = (busyScan.json as { taskId: string }).taskId
    const overlap = await write('scans.run', versions(library), { libraryId: 1 })
    assert.equal(overlap.status, 409, JSON.stringify(overlap.json))
    assert.equal((overlap.json as { code?: string }).code, 'MAINTENANCE_BUSY')

    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const remote = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    const local = createLocalCatalogBackend({
      identity: { mode: 'local', catalogId: writer.catalogId }
    })
    try {
      const cancelled = await write('scans.cancel', versions(library), { libraryId: 1, taskId: busyId })
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.json))
      const cancelState = (cancelled.json as { state: string }).state
      assert.equal(['cancelRequested', 'cancelled', 'succeeded'].includes(cancelState), true, cancelState)
      const afterCancel = await pollTask(busyId)
      assert.equal(['cancelled', 'succeeded'].includes(afterCancel.state), true, afterCancel.state)

      const beforeNfo = getDb()
        .prepare("SELECT id, generation, revision FROM videos WHERE code = 'ABC-001'")
        .get() as { id: number; generation: number; revision: number }
      const nfoPlan = await write('nfo.plan', versions(library), {
        libraryIds: [1],
        profileId: 'portable-v1',
        includeCover: true,
        includeFanart: false,
        includeSamples: false,
        includeActorAvatars: false,
        collisionPolicy: 'replace'
      })
      assert.equal(nfoPlan.status, 200, JSON.stringify(nfoPlan.json))
      const plan = nfoPlan.json as {
        planId: string
        planDigest: string
        warnings: string[]
        summary: { fileCount: number }
      }
      assert.equal(plan.warnings.some((warning) => warning.includes('只写 XML')), true)
      assert.equal(plan.summary.fileCount >= 1, true)
      const nfoStart = await write('nfo.start', versions(library), {
        planId: plan.planId,
        planDigest: plan.planDigest
      })
      assert.equal(nfoStart.status, 200, JSON.stringify(nfoStart.json))
      const nfoTask = await pollTask((nfoStart.json as { taskId: string }).taskId)
      assert.equal(['succeeded', 'needsInspection'].includes(nfoTask.state), true, JSON.stringify(nfoTask))
      assert.equal(fs.existsSync(path.join(s09Mount, 'ABC-001.nfo')), true)
      const nfoXml = fs.readFileSync(path.join(s09Mount, 'ABC-001.nfo'), 'utf8')
      assert.match(nfoXml, /ABC-001/)
      assert.equal(fs.existsSync(path.join(s09Mount, 'ABC-001-poster.jpg')), false)

      const afterNfo = getDb()
        .prepare('SELECT generation, revision FROM videos WHERE id = ?')
        .get(beforeNfo.id) as { generation: number; revision: number }
      assert.deepEqual(afterNfo, { generation: beforeNfo.generation, revision: beforeNfo.revision })
      assert.deepEqual(afterNfo, afterFirstScan)
      const nfoThenTitle = await write(
        'videos.edit',
        { V: { generation: beforeNfo.generation, revision: beforeNfo.revision } },
        { videoId: beforeNfo.id, fields: { title: 'After NFO' } }
      )
      assert.equal(nfoThenTitle.status, 200, JSON.stringify(nfoThenTitle.json))
      const titled = getDb()
        .prepare('SELECT title, revision FROM videos WHERE id = ?')
        .get(beforeNfo.id) as { title: string; revision: number }
      assert.equal(titled.title, 'After NFO')
      assert.equal(titled.revision, beforeNfo.revision + 1)

      const resource = getDb()
        .prepare(
          `SELECT resource.id AS id, resource.locator AS locator
             FROM video_resources resource
             JOIN videos video ON video.id = resource.video_id
            WHERE resource.library_id = 1 AND video.code = 'ABC-001'
            LIMIT 1`
        )
        .get() as { id: number; locator: string }
      const location = {
        rootId: addedRoot.id,
        relativePath: path.relative(s09Mount, resource.locator) || path.basename(resource.locator)
      }
      const staleRename = await write('files.rename', versions(library), {
        libraryId: 1,
        resourceId: resource.id,
        location,
        newFileName: 'ABC-001-renamed.mp4',
        planId: randomUUID(),
        planDigest: 'a'.repeat(64)
      })
      assert.equal(staleRename.status, 409, JSON.stringify(staleRename.json))
      assert.equal((staleRename.json as { code?: string }).code, 'VERSION_CONFLICT')
      const digest = filesRenameDigest({
        libraryId: 1,
        resourceId: resource.id,
        location,
        newFileName: 'ABC-001-renamed.mp4'
      })
      const renamed = await write('files.rename', versions(library), {
        libraryId: 1,
        resourceId: resource.id,
        location,
        newFileName: 'ABC-001-renamed.mp4',
        planId: randomUUID(),
        planDigest: digest
      })
      assert.equal(renamed.status, 200, JSON.stringify(renamed.json))
      assert.equal(fs.existsSync(path.join(s09Mount, 'ABC-001-renamed.mp4')), true)

      fs.unlinkSync(path.join(s09Mount, JAVDEX_ROOT_MARKER))
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const missingMarker = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(missingMarker.status, 200, JSON.stringify(missingMarker.json))
      const missingTask = await pollTask((missingMarker.json as { taskId: string }).taskId)
      assert.equal(missingTask.state, 'succeeded')
      const missingLatest = (await read('scans.getLatest', { libraryId: 1 })).json as {
        summary?: { offlineFolders?: string[] }
        offlineFolders?: string[]
      }
      const missingOffline = missingLatest.summary?.offlineFolders ?? missingLatest.offlineFolders ?? []
      assert.equal(missingOffline.some((folder) => folder === addedRoot.path || folder === s09Mount), true, JSON.stringify(missingLatest))
      assert.equal(fs.existsSync(s09Mount), true)
      assert.equal(fs.existsSync(path.join(s09Mount, JAVDEX_ROOT_MARKER)), false)

      fs.writeFileSync(path.join(s09Mount, JAVDEX_ROOT_MARKER), '')
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const extraAdded = await write('libraries.addRoot', versions(library), {
        libraryId: 1,
        root: { mountSelectionId: 'extra' }
      })
      assert.equal(extraAdded.status, 200, JSON.stringify(extraAdded.json))
      const extraRoot = extraAdded.json as { id: number; path: string }
      const unmounted = `${extraMount}.off`
      fs.renameSync(extraMount, unmounted)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const unmountScan = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(unmountScan.status, 200, JSON.stringify(unmountScan.json))
      const unmountTask = await pollTask((unmountScan.json as { taskId: string }).taskId)
      assert.equal(unmountTask.state, 'succeeded')
      const unmountLatest = (await read('scans.getLatest', { libraryId: 1 })).json as {
        summary?: { offlineFolders?: string[] }
        offlineFolders?: string[]
      }
      const unmountOffline = unmountLatest.summary?.offlineFolders ?? unmountLatest.offlineFolders ?? []
      assert.equal(
        unmountOffline.some((folder) => folder === extraRoot.path || folder === extraMount),
        true,
        JSON.stringify(unmountLatest)
      )
      assert.equal(fs.existsSync(extraMount), false)
      fs.renameSync(unmounted, extraMount)

      const impact = previewLibraryPathRemoval({ libraryId: 1, rootId: extraRoot.id })
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const removed = await write('libraries.removeRoot', versions(library), {
        libraryId: 1,
        rootId: extraRoot.id,
        planId: randomUUID(),
        planDigest: impact.impactRevision
      })
      assert.equal(removed.status, 200, JSON.stringify(removed.json))

      const remoteLatest = await remote.libraries.latestScan({ libraryId: 1 })
      const localLatest = await local.libraries.latestScan({ libraryId: 1 })
      assert.equal(Boolean(remoteLatest), true)
      assert.equal(Boolean(localLatest), true)
    } finally {
      await remote.dispose()
      await local.dispose()
    }
  })

  it('confirms a staged scrape, applies candidates, imports a playlist, and freezes a target list', async () => {
    const dataDir = path.join(root, 's10-apply')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const uniqueClip = (code: string): string => {
      const filePath = path.join(mediaRoot, `${code}.mp4`)
      fs.writeFileSync(filePath, Buffer.from(code))
      return filePath
    }
    const { videoId } = await insertBoundVideo('S10-001', uniqueClip('S10-001'))
    const second = await insertBoundVideo('S10-002', uniqueClip('S10-002'))
    const png = await sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 12, g: 80, b: 40 } }
    })
      .png()
      .toBuffer()
    const staged = mediaAssetStore.stageVideoScrapeImages([
      { field: 'cover', position: 0, remoteUrl: 'https://example.test/cover.png', data: png }
    ])
    const pending = replacePendingVideoScrape({
      videoId,
      selectedFields: ['title', 'cover'],
      applicableFields: ['title', 'cover'],
      updateMode: 'replace',
      request: { source: 's10-test' },
      warnings: [],
      sources: [
        {
          pluginName: 's10',
          pluginSource: 'builtin',
          pluginVersion: '1',
          pluginConfig: {},
          sourceName: 's10',
          selectedFields: ['title', 'cover'],
          candidates: [
            {
              result: {
                code: 'S10-001',
                title: 'Confirmed Title',
                coverUrl: 'https://example.test/cover.png'
              },
              sourceUrl: 'https://example.test/s10-001',
              normalizedSourceUrl: 'https://example.test/s10-001',
              resources: staged.map((item) => ({
                field: item.field,
                position: item.position,
                remoteUrl: item.remoteUrl,
                stagedPath: item.stagedPath,
                width: item.width,
                height: item.height,
                sizeBytes: item.sizeBytes
              }))
            }
          ]
        }
      ]
    })
    const pendingRow = getPendingVideoScrapeById(pending.pendingScrapeId)!
    const videoVersion = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(videoId) as { generation: number; revision: number }
    const confirm = await postManage(
      base,
      'pendingVideoScrapes.confirm',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {
          V: videoVersion,
          Q: { generation: 1, revision: pendingRow.revision }
        },
        input: {
          pendingScrapeId: pending.pendingScrapeId,
          selections: [
            {
              sourceId: pendingRow.sources[0].id,
              candidateId: pendingRow.sources[0].candidates[0].id
            }
          ]
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(confirm.status, 200, JSON.stringify(confirm.json))
    assert.equal((confirm.json as { applied: boolean }).applied, true)
    const confirmed = getDb()
      .prepare('SELECT title, cover_path FROM videos WHERE id = ?')
      .get(videoId) as { title: string; cover_path: string }
    assert.equal(confirmed.title, 'Confirmed Title')
    assert.ok(confirmed.cover_path?.startsWith('covers/'))
    assert.equal(fs.existsSync(path.join(dataDir, 'media_assets', confirmed.cover_path)), true)
    assert.equal(getPendingVideoScrapeById(pending.pendingScrapeId), null)

    const applyVersion = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(second.videoId) as { generation: number; revision: number }
    const apply = await postManage(
      base,
      'videos.applyScrapeCandidate',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: applyVersion },
        input: {
          videoId: second.videoId,
          fields: ['title'],
          mode: 'replace',
          candidate: { code: 'S10-002', title: 'Applied Candidate' }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(apply.status, 200, JSON.stringify(apply.json))
    assert.equal((apply.json as { applied: boolean }).applied, true)
    const appliedTitle = getDb()
      .prepare('SELECT title FROM videos WHERE id = ?')
      .get(second.videoId) as { title: string }
    assert.equal(appliedTitle.title, 'Applied Candidate')

    const actressId = upsertActressFromScrape('S10 Star', null, 'female')
    const actressVersion = getDb()
      .prepare('SELECT generation, revision FROM actresses WHERE id = ?')
      .get(actressId) as { generation: number; revision: number }
    const actressApply = await postManage(
      base,
      'actresses.applyScrapeCandidate',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { A: actressVersion },
        input: {
          actressId,
          candidate: { mainName: 'S10 Star', nameZh: '测试演员', nationality: 'JP' }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(actressApply.status, 200, JSON.stringify(actressApply.json))

    const avatarUpload = await postManage(
      base,
      'uploads.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { purpose: 'actressAvatar', contentType: 'image/png' }
      },
      { bearer: writer.secret }
    )
    assert.equal(avatarUpload.status, 200, JSON.stringify(avatarUpload.json))
    const avatarUploadId = (avatarUpload.json as { uploadId: string }).uploadId
    const avatarPut = await putUpload(base, avatarUploadId, png, { bearer: writer.secret })
    assert.equal(avatarPut.status, 200, JSON.stringify(avatarPut.json))
    const afterActressApply = getDb()
      .prepare('SELECT generation, revision FROM actresses WHERE id = ?')
      .get(actressId) as { generation: number; revision: number }
    const setAvatar = await postManage(
      base,
      'actresses.setPoster',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { A: afterActressApply },
        input: { actressId, image: { kind: 'upload', uploadId: avatarUploadId } }
      },
      { bearer: writer.secret }
    )
    assert.equal(setAvatar.status, 200, JSON.stringify(setAvatar.json))
    const avatarRow = getDb()
      .prepare('SELECT avatar_source_path, generation, revision FROM actresses WHERE id = ?')
      .get(actressId) as {
      avatar_source_path: string
      generation: number
      revision: number
    }
    assert.ok(avatarRow.avatar_source_path)
    const sourceDigest = createHash('sha256')
      .update(mediaAssetStore.readBytes(avatarRow.avatar_source_path))
      .digest('hex')
    const cropUpload = await postManage(
      base,
      'uploads.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { purpose: 'actressAvatar', contentType: 'image/png' }
      },
      { bearer: writer.secret }
    )
    assert.equal(cropUpload.status, 200, JSON.stringify(cropUpload.json))
    const cropUploadId = (cropUpload.json as { uploadId: string }).uploadId
    const cropPng = await sharp({
      create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 10, b: 10 } }
    })
      .png()
      .toBuffer()
    const cropPut = await putUpload(base, cropUploadId, cropPng, { bearer: writer.secret })
    assert.equal(cropPut.status, 200, JSON.stringify(cropPut.json))
    const staleCrop = await postManage(
      base,
      'actresses.applyCrop',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { A: { generation: avatarRow.generation, revision: avatarRow.revision } },
        input: {
          actressId,
          sourceAssetId: actressId,
          sourceDigest: '0'.repeat(64),
          sourceVersion: String(avatarRow.revision),
          image: { kind: 'upload', uploadId: cropUploadId }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(staleCrop.status, 409, JSON.stringify(staleCrop.json))
    const cropped = await postManage(
      base,
      'actresses.applyCrop',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { A: { generation: avatarRow.generation, revision: avatarRow.revision } },
        input: {
          actressId,
          sourceAssetId: actressId,
          sourceDigest,
          sourceVersion: String(avatarRow.revision),
          image: { kind: 'upload', uploadId: cropUploadId }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(cropped.status, 200, JSON.stringify(cropped.json))

    const agentVideo = await insertBoundVideo('S10-003', uniqueClip('S10-003'))
    const now = new Date().toISOString()
    getDb()
      .prepare(
        `INSERT INTO agent_runs (
           id, use_case, status, config_revision, config_snapshot_json, runtime_id,
           product_state_json, created_at, updated_at
         ) VALUES (?, 'metadata-collector', 'running', 's10', '{}', 'pi', '{}', ?, ?)`
      )
      .run('s10-agent-run', now, now)
    const drafts = new AgentMetadataDraftRepo()
    const createdDraft = drafts.create({
      id: 's10-agent-draft',
      runId: 's10-agent-run',
      target: { kind: 'video', id: agentVideo.videoId },
      source: {
        requestedUrl: 'https://example.test/s10-003',
        finalUrl: 'https://example.test/s10-003',
        displayUrl: 'https://example.test/s10-003',
        sourceName: 's10'
      },
      payload: {
        kind: 'video',
        result: { code: 'S10-003', title: 'Agent Applied Title' },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: []
      },
      resources: [],
      warnings: []
    }).draft
    drafts.saveReview({
      draftId: createdDraft.id,
      expectedRevision: createdDraft.revision,
      review: {
        kind: 'video',
        draftId: createdDraft.id,
        revision: createdDraft.revision + 1,
        token: 's10-review-token',
        selection: {
          kind: 'video',
          draftId: createdDraft.id,
          expectedRevision: createdDraft.revision + 1,
          fields: ['title'],
          mode: 'replace'
        },
        impacts: [],
        warnings: [],
        classifications: [],
        canApply: true
      }
    })
    const ready = await postManage(
      base,
      'agentMetadata.findReady',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { target: { kind: 'video', id: agentVideo.videoId } }
      },
      { bearer: writer.secret }
    )
    assert.equal(ready.status, 200, JSON.stringify(ready.json))
    assert.equal((ready.json as { draft: { id: string } | null }).draft?.id, createdDraft.id)
    const readyDraft = drafts.require(createdDraft.id)
    const agentVideoVersion = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(agentVideo.videoId) as { generation: number; revision: number }
    const agentApply = await postManage(
      base,
      'agentMetadata.apply',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {
          V: agentVideoVersion,
          Q: { generation: 1, revision: readyDraft.revision }
        },
        input: { draftId: createdDraft.id, reviewToken: 's10-review-token' }
      },
      { bearer: writer.secret }
    )
    assert.equal(agentApply.status, 200, JSON.stringify(agentApply.json))
    assert.equal((agentApply.json as { status: string }).status, 'applied')
    const agentTitle = getDb()
      .prepare('SELECT title FROM videos WHERE id = ?')
      .get(agentVideo.videoId) as { title: string }
    assert.equal(agentTitle.title, 'Agent Applied Title')

    const discardVideo = await insertBoundVideo('S10-004', uniqueClip('S10-004'))
    const discardDraft = drafts.create({
      id: 's10-agent-discard',
      runId: 's10-agent-run',
      target: { kind: 'video', id: discardVideo.videoId },
      source: {
        requestedUrl: 'https://example.test/s10-004',
        displayUrl: 'https://example.test/s10-004',
        sourceName: 's10'
      },
      payload: {
        kind: 'video',
        result: { code: 'S10-004', title: 'Discard Me' },
        observedFields: ['title'],
        explicitlyEmptyFields: [],
        evidenceRefs: []
      },
      resources: [],
      warnings: []
    }).draft
    const discarded = await postManage(
      base,
      'agentMetadata.discard',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { Q: { generation: 1, revision: discardDraft.revision } },
        input: { draftId: discardDraft.id }
      },
      { bearer: writer.secret }
    )
    assert.equal(discarded.status, 200, JSON.stringify(discarded.json))
    assert.equal(drafts.require(discardDraft.id).status, 'discarded')

    const library = (await postManage(
      base,
      'libraries.get',
      { serverId: writer.serverId, catalogId: writer.catalogId, input: { libraryId: 1 } },
      { bearer: writer.secret }
    )).json as { revision: number }
    const stalePreview = await postManage(
      base,
      'videos.previewDeleteGlobal',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input: { videoId: second.videoId }
      },
      { bearer: writer.secret }
    )
    assert.equal(stalePreview.status, 200, JSON.stringify(stalePreview.json))
    const staleImpact = stalePreview.json as { revision: string; playlistCount: number }
    assert.equal(staleImpact.playlistCount, 0)
    const imported = await postManage(
      base,
      'playlists.applyImport',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {
          L: { generation: 1, revision: library.revision },
          V: getDb()
            .prepare('SELECT generation, revision FROM videos WHERE id = ?')
            .get(videoId) as { generation: number; revision: number }
        },
        input: {
          name: 'S10 Import',
          libraryId: 1,
          videoIds: [videoId, second.videoId],
          sourceUrl: 'https://example.test/list'
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(imported.status, 200, JSON.stringify(imported.json))
    const playlistId = (imported.json as { playlistId: number }).playlistId
    const members = getDb()
      .prepare('SELECT video_id FROM playlist_video WHERE playlist_id = ? ORDER BY position')
      .all(playlistId) as Array<{ video_id: number }>
    assert.deepEqual(
      members.map((row) => row.video_id),
      [videoId, second.videoId]
    )
    const staleDelete = await postManage(
      base,
      'videos.deleteGlobal',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: {
          videoId: second.videoId,
          planId: randomUUID(),
          planDigest: staleImpact.revision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(staleDelete.status, 409, JSON.stringify(staleDelete.json))
    assert.equal((staleDelete.json as { code?: string }).code, 'VERSION_CONFLICT')
    assert.equal(
      (getDb().prepare('SELECT id FROM videos WHERE id = ?').get(second.videoId) as { id: number } | undefined)?.id,
      second.videoId
    )

    const digest = targetListFilterDigest('videos.status:all')
    const createdList = await postManage(
      base,
      'targetLists.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { kind: 'videos.status:all', filterDigest: digest }
      },
      { bearer: writer.secret }
    )
    assert.equal(createdList.status, 200, JSON.stringify(createdList.json))
    const targetListId = (createdList.json as { targetListId: string }).targetListId
    const page = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId }
      },
      { bearer: writer.secret }
    )
    assert.equal(page.status, 200, JSON.stringify(page.json))
    const ids = (page.json as { ids: number[] }).ids
    assert.equal(ids.includes(videoId), true)
    assert.equal(ids.includes(second.videoId), true)
    const firstPage = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId, limit: 1, offset: 0 }
      },
      { bearer: writer.secret }
    )
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.json))
    const firstIds = (firstPage.json as { ids: number[]; hasMore: boolean }).ids
    assert.equal(firstIds.length, 1)
    await insertBoundVideo('S10-005', uniqueClip('S10-005'))
    const nextPage = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId, limit: 1, offset: 1 }
      },
      { bearer: writer.secret }
    )
    assert.equal(nextPage.status, 200, JSON.stringify(nextPage.json))
    const nextIds = (nextPage.json as { ids: number[]; hasMore: boolean }).ids
    assert.equal(nextIds.length, 1)
    assert.equal(ids.includes(nextIds[0]), true)
    assert.equal(nextIds[0] === firstIds[0], false)
    const afterInsert = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId }
      },
      { bearer: writer.secret }
    )
    assert.equal(afterInsert.status, 200, JSON.stringify(afterInsert.json))
    assert.deepEqual((afterInsert.json as { ids: number[] }).ids, ids)
    const stale = await postManage(
      base,
      'targetLists.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { kind: 'videos.status:all', filterDigest: '0'.repeat(64) }
      },
      { bearer: writer.secret }
    )
    assert.equal(stale.status, 409, JSON.stringify(stale.json))
    assert.equal((stale.json as { code?: string }).code, 'VERSION_CONFLICT')

    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const remote = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    const local = createLocalCatalogBackend({
      identity: { mode: 'local', catalogId: writer.catalogId }
    })
    try {
      const remotePage = (await remote.tasks.pageTargetList({ targetListId })) as { ids: number[] }
      const localPage = (await local.tasks.pageTargetList({ targetListId })) as { ids: number[] }
      assert.deepEqual(remotePage.ids, localPage.ids)
    } finally {
      await remote.dispose()
      await local.dispose()
    }
  })

  it('grants a 12-hour play token, streams Range, and serves manage images without cookies', async () => {
    const dataDir = path.join(root, 's11-play')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const clip = path.join(mediaRoot, 'S11-001.mp4')
    fs.writeFileSync(clip, Buffer.from('0123456789abcdef'))
    const { videoId, fileId } = await insertBoundVideo('S11-001', clip)
    const resource = getDb()
      .prepare('SELECT * FROM video_resources WHERE id = ?')
      .get(fileId) as {
        kind: 'local'
        locator: string
        source_identity: string | null
        root_id: number | null
        size_bytes: number | null
        file_mtime_ms: number | null
      }
    const locatorRevision = resourceLocatorRevision(resource)
    const granted = await postManage(
      base,
      'play.grant',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input: {
          libraryId: 1,
          videoId,
          resourceId: fileId,
          locatorRevision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(granted.status, 200, JSON.stringify(granted.json))
    const play = granted.json as {
      grantId: string
      expiresAt: string
      playbackHandle: string
      methods: string[]
      range: boolean
    }
    assert.equal(play.range, true)
    assert.deepEqual(play.methods, ['HEAD', 'GET'])
    assert.match(play.playbackHandle, /^http:\/\/127\.0\.0\.1:\d+\/play\/v1\//)
    const ttlMs = Date.parse(play.expiresAt) - Date.now()
    assert.ok(ttlMs > PLAY_GRANT_TTL_MS - 60_000)
    assert.ok(ttlMs <= PLAY_GRANT_TTL_MS + 5_000)
    const handle = new URL(play.playbackHandle)
    const head = await fetch(play.playbackHandle, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    const ranged = await fetch(play.playbackHandle, { headers: { Range: 'bytes=0-3' } })
    assert.equal(ranged.status, 206)
    assert.equal(Buffer.from(await ranged.arrayBuffer()).toString(), '0123')
    const cookiePlay = await fetch(`http://${handle.host}${handle.pathname}`, {
      headers: { Cookie: 'javdex_web_session=not-a-grant' }
    })
    assert.equal(cookiePlay.status, 404)
    const badToken = await fetch(`${handle.origin}${handle.pathname}?t=not-the-grant`)
    assert.equal(badToken.status, 404)
    const staleGrant = await postManage(
      base,
      'play.grant',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input: {
          libraryId: 1,
          videoId,
          resourceId: fileId,
          locatorRevision: '0'.repeat(64)
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(staleGrant.status, 409)
    assert.equal((staleGrant.json as { code?: string }).code, 'VERSION_CONFLICT')

    getDb().prepare('UPDATE videos SET title = ? WHERE id = ?').run('S11 title only', videoId)
    const stillPlaying = await fetch(play.playbackHandle, { headers: { Range: 'bytes=4-7' } })
    assert.equal(stillPlaying.status, 206)
    assert.equal(Buffer.from(await stillPlaying.arrayBuffer()).toString(), '4567')

    const png = await sharp({
      create: { width: 10, height: 8, channels: 3, background: { r: 9, g: 18, b: 27 } }
    })
      .png()
      .toBuffer()
    const coverRel = 'covers/s11-cover.png'
    fs.mkdirSync(path.join(dataDir, 'media_assets', 'covers'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'media_assets', coverRel), png)
    getDb().prepare('UPDATE videos SET cover_path = ? WHERE id = ?').run(coverRel, videoId)
    const image = await fetch(`${base}/manage/v1/assets/${coverRel}`, {
      headers: {
        Origin: base,
        Authorization: `Bearer ${writer.secret}`,
        'X-Javdex-App-Version': SERVER_APP_VERSION
      }
    })
    assert.equal(image.status, 200, await image.text())
    assert.match(image.headers.get('content-type') ?? '', /image\/png/)
    const cookieImage = await fetch(`${base}/manage/v1/assets/${coverRel}`, {
      headers: {
        Origin: base,
        Cookie: 'javdex_web_session=browser',
        'X-Javdex-App-Version': SERVER_APP_VERSION
      }
    })
    assert.equal(cookieImage.status, 401)
    const traversal = await fetch(
      `${base}/manage/v1/assets/${encodeURIComponent('covers/../../library.db')}`,
      {
        headers: {
          Origin: base,
          Authorization: `Bearer ${writer.secret}`,
          'X-Javdex-App-Version': SERVER_APP_VERSION
        }
      }
    )
    assert.equal(traversal.status, 400)

    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const remote = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    try {
      const remoteGrant = (await remote.assets.grantPlayback({
        libraryId: 1,
        videoId,
        resourceId: fileId,
        locatorRevision
      })) as { playbackHandle: string }
      assert.match(remoteGrant.playbackHandle, /^http:\/\/127\.0\.0\.1:\d+\/play\/v1\//)
      const remoteImage = await remote.assets.readImage({ relPath: coverRel })
      assert.equal(remoteImage.mime, 'image/png')
      assert.ok(remoteImage.body.length > 0)
    } finally {
      await remote.dispose()
    }

    const handoff = await postManage(
      base,
      'writer.handoffBegin',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: {}
      },
      { bearer: writer.secret }
    )
    assert.equal(handoff.status, 200, JSON.stringify(handoff.json))
    const nextSecret = generateSecret()
    const consumed = await postManage(base, 'writer.claim', {
      serverId: writer.serverId,
      catalogId: writer.catalogId,
      input: {
        kind: 'handoff',
        oneTimeToken: (handoff.json as { oneTimeToken: string }).oneTimeToken,
        candidate: { claimId: randomUUID(), secretDigest: digestToken(nextSecret) }
      }
    })
    assert.equal(consumed.status, 200, JSON.stringify(consumed.json))
    const revokedPlay = await fetch(play.playbackHandle, { headers: { Range: 'bytes=0-3' } })
    assert.equal(revokedPlay.status, 404)

    const nextEpoch = (consumed.json as { writerEpoch: number }).writerEpoch
    const nextGrant = await postManage(
      base,
      'play.grant',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: nextEpoch,
        input: {
          libraryId: 1,
          videoId,
          resourceId: fileId,
          locatorRevision
        }
      },
      { bearer: nextSecret }
    )
    assert.equal(nextGrant.status, 200, JSON.stringify(nextGrant.json))
    const nextPlay = nextGrant.json as { grantId: string; playbackHandle: string; expiresAt: string }
    const nextHandle = new URL(nextPlay.playbackHandle)
    const live = await fetch(nextPlay.playbackHandle, { method: 'HEAD' })
    assert.equal(live.status, 200)
    assert.throws(
      () =>
        inspectPlayStream({
          grantId: nextPlay.grantId,
          token: nextHandle.searchParams.get('t') ?? '',
          now: new Date(Date.parse(nextPlay.expiresAt) + 1)
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'
    )
    const expired = await fetch(nextPlay.playbackHandle, { method: 'HEAD' })
    assert.equal(expired.status, 404)
  })

  it('authorizes migration ops with a CLI token, freezes source writes, and ignores cookies', async () => {
    const dataDir = path.join(root, 's12-migration')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const clip = path.join(mediaRoot, 'S12-HTTP.mp4')
    fs.writeFileSync(clip, Buffer.from('0123456789abcdef'))
    await insertBoundVideo('S12-HTTP', clip)
    const rootId = (
      getDb().prepare('SELECT id FROM media_library_roots LIMIT 1').get() as { id: number }
    ).id
    const cookie = (await login(base, password)).cookie
    const issued = issueMigrationToken(config)
    const dummyId = randomUUID()
    const putHeaders = (extra: Record<string, string>): Record<string, string> => ({
      Origin: base,
      'Content-Type': 'application/octet-stream',
      'X-Javdex-App-Version': SERVER_APP_VERSION,
      ...extra
    })
    const cookiePut = await fetch(`${base}/manage/v1/migration/packages/${dummyId}`, {
      method: 'PUT',
      headers: putHeaders({ Cookie: cookie }),
      body: Buffer.from('pkg')
    })
    assert.equal(cookiePut.status, 401)
    const writerPut = await fetch(`${base}/manage/v1/migration/packages/${dummyId}`, {
      method: 'PUT',
      headers: putHeaders({ Authorization: `Bearer ${writer.secret}` }),
      body: Buffer.from('pkg')
    })
    assert.equal(writerPut.status, 401)
    const tokenPut = await fetch(`${base}/manage/v1/migration/packages/${dummyId}`, {
      method: 'PUT',
      headers: putHeaders({ Authorization: `Bearer ${issued.oneTimeToken}` }),
      body: Buffer.from('pkg')
    })
    assert.equal(tokenPut.status, 200, await tokenPut.text())
    const cookiePreview = await postManage(
      base,
      'migration.preview',
      { input: { mappings: [{ sourceRootId: rootId, targetMountSelectionId: 'library' }] } },
      { cookie }
    )
    assert.equal(cookiePreview.status, 401)
    const writerPreview = await postManage(
      base,
      'migration.preview',
      { input: { mappings: [{ sourceRootId: rootId, targetMountSelectionId: 'library' }] } },
      { bearer: writer.secret }
    )
    assert.equal(writerPreview.status, 401)
    const preview = await postManage(
      base,
      'migration.preview',
      { input: { mappings: [{ sourceRootId: rootId, targetMountSelectionId: 'library' }] } },
      { bearer: issued.oneTimeToken }
    )
    assert.equal(preview.status, 200, JSON.stringify(preview.json))
    const body = preview.json as { migrationId: string; digest: string }
    const started = await postManage(
      base,
      'migration.start',
      { input: { migrationId: body.migrationId, digest: body.digest } },
      { bearer: issued.oneTimeToken }
    )
    assert.equal(started.status, 200, JSON.stringify(started.json))
    assert.equal((started.json as { state?: string }).state, 'succeeded')
    const frozenEdit = await postManage(
      base,
      'videos.list',
      { serverId: writer.serverId, catalogId: writer.catalogId, input: { scope: { kind: 'all' } } },
      { bearer: writer.secret }
    )
    assert.equal(frozenEdit.status, 403)
    assert.equal((frozenEdit.json as { code?: string }).code, 'CATALOG_FROZEN')
    const remote = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map()),
      migrationSecret: issued.oneTimeToken
    })
    try {
      const status = (await remote.migration.status({ migrationId: body.migrationId })) as {
        sourcePhase: string
      }
      assert.equal(status.sourcePhase, 'frozen')
    } finally {
      await remote.dispose()
    }
  })
})

describe('RemoteCatalogBackend reconnect isolation', () => {
  it('bumps generation and aborts an in-flight query so a late response cannot replace the new session', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let videosGetCount = 0
    const http = createHttpServer((request, response) => {
      const url = request.url ?? ''
      const send = (body: unknown): void => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(body))
      }
      if (url.endsWith('/handshake.get')) {
        send({
          protocolVersion: 1,
          appVersion: '0.7.0',
          schemaVersion: 18,
          identity: { serverId: 'server-1', catalogId: 'catalog-1' },
          writerEpoch: 1,
          ready: 'ready',
          capabilities: {
            encryptedAssets: false,
            transcoding: false,
            arbitraryUrlProxy: false,
            pluginExecution: false,
            publicInternetDefault: false,
            writerBound: true,
            browserEnabled: true,
            managementEnabled: true
          }
        })
        return
      }
      if (url.endsWith('/videos.get')) {
        videosGetCount += 1
        const count = videosGetCount
        void hold.then(() => {
          try {
            if (response.writableEnded) return
            send({ id: 1, title: count === 1 ? 'late-stale' : 'fresh' })
          } catch {
            // Client already aborted the stale generation.
          }
        })
        return
      }
      response.statusCode = 404
      send({ code: 'INVALID_INPUT', message: url })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('port')
    const base = `http://127.0.0.1:${address.port}`
    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: '0.7.0',
      credentials: {
        async isAvailable() {
          return true
        },
        async readWriterSecret() {
          return 'writer-secret'
        },
        async writeWriterSecret() {
          return
        },
        async deleteWriterSecret() {
          return
        }
      }
    })
    try {
      const pending = backend.queries.getVideo({ scope: { kind: 'all' }, videoId: 1 })
      const pendingError = pending.then(
        () => {
          throw new Error('stale generation query resolved')
        },
        (error: unknown) => error
      )
      const started = Date.now()
      while (videosGetCount < 1 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(videosGetCount >= 1, true)
      assert.equal(backend.generation, 1)
      const next = await backend.reconnect()
      assert.equal(next.generation, 2)
      assert.equal(backend.generation, 2)
      const aborted = await pendingError
      assert.equal(isStructuredError(aborted) && aborted.code === 'CONNECTION_UNAVAILABLE', true)
      release()
      const fresh = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId: 1
      })) as { title: string }
      assert.equal(fresh.title, 'fresh')
      assert.equal(backend.session().generation, 2)
      assert.equal(backend.session().state, 'available')
    } finally {
      await backend.dispose()
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('dispose aborts an in-flight query and does not apply a late response', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => {
      release = resolve
    })
    let videosGetCount = 0
    const http = createHttpServer((request, response) => {
      const url = request.url ?? ''
      const send = (body: unknown): void => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(body))
      }
      if (url.endsWith('/handshake.get')) {
        send({
          protocolVersion: 1,
          appVersion: '0.7.0',
          schemaVersion: 18,
          identity: { serverId: 'server-1', catalogId: 'catalog-1' },
          writerEpoch: 1,
          ready: 'ready',
          capabilities: {
            encryptedAssets: false,
            transcoding: false,
            arbitraryUrlProxy: false,
            pluginExecution: false,
            publicInternetDefault: false,
            writerBound: true,
            browserEnabled: true,
            managementEnabled: true
          }
        })
        return
      }
      if (url.endsWith('/videos.get')) {
        videosGetCount += 1
        void hold.then(() => {
          try {
            if (response.writableEnded) return
            send({ id: 1, title: 'after-dispose' })
          } catch {
            // Client already aborted.
          }
        })
        return
      }
      response.statusCode = 404
      send({ code: 'INVALID_INPUT', message: url })
    })
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('port')
    const backend = createRemoteCatalogBackend({
      baseUrl: `http://127.0.0.1:${address.port}`,
      appVersion: '0.7.0',
      credentials: {
        async isAvailable() {
          return true
        },
        async readWriterSecret() {
          return 'writer-secret'
        },
        async writeWriterSecret() {
          return
        },
        async deleteWriterSecret() {
          return
        }
      }
    })
    try {
      const pending = backend.queries.getVideo({ scope: { kind: 'all' }, videoId: 1 })
      const pendingError = pending.then(
        () => {
          throw new Error('disposed query resolved')
        },
        (error: unknown) => error
      )
      const started = Date.now()
      while (videosGetCount < 1 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(videosGetCount >= 1, true)
      await backend.dispose()
      const aborted = await pendingError
      assert.equal(isStructuredError(aborted) && aborted.code === 'CONNECTION_UNAVAILABLE', true)
      release()
      assert.equal(backend.session().state, 'disconnected')
    } finally {
      await backend.dispose()
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
