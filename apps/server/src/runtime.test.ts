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
import { issueDeployToken } from './identity'
import { dispatchManageOperation } from './manageDispatch'
import { startJavdexServer, type JavdexServerHandle } from './runtime'
import type { ServerConfig } from './config'
import { SERVER_APP_VERSION } from './appVersion'
import { randomUUID } from 'node:crypto'
import { createRemoteCatalogBackend } from '../../desktop/src/main/backends/remote/remoteCatalogBackend'
import { createLocalCatalogBackend } from '../../desktop/src/main/backends/local/localCatalogBackend'
import { upsertActressFromScrape } from '@library/db/actressRepo'
import { filesRenameDigest } from '@library/catalog/catalogFileMaintenance'
import { previewLibraryPathRemoval } from '@library/scan/libraryPathCleanupService'
import { JAVDEX_ROOT_MARKER } from '@library/scan/javdexRootMarker'

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
            isLoopback: false
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

      await remote.videos.addManualTag({ videoId, name: 's08-manual' }, {
        operationId: randomUUID(),
        expectedVersions: { V: version }
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
      .prepare("SELECT code FROM videos WHERE code = 'ABC-001'")
      .get() as { code: string } | undefined
    assert.equal(video?.code, 'ABC-001')

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
