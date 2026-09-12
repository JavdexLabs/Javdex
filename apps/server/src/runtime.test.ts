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
      const started = Date.now()
      while (videosGetCount < 1 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(videosGetCount >= 1, true)
      assert.equal(backend.generation, 1)
      const next = await backend.reconnect()
      assert.equal(next.generation, 2)
      assert.equal(backend.generation, 2)
      await assert.rejects(
        pending,
        (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
      )
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
      const started = Date.now()
      while (videosGetCount < 1 && Date.now() - started < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(videosGetCount >= 1, true)
      await backend.dispose()
      await assert.rejects(
        pending,
        (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
      )
      release()
      assert.equal(backend.session().state, 'disconnected')
    } finally {
      await backend.dispose()
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
