import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
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
import { ensureVideoMembership } from '@library/db/libraryMembershipRepo'
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
import { SCAN_CLEANUP_PAGE_SIZE } from '@library/scan/scanCleanupPages'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  getPendingVideoScrapeById,
  replacePendingVideoScrape
} from '@library/db/pendingVideoScrapeRepo'
import { targetListFilterDigest } from '@library/catalog/catalogTargetLists'
import { inspectPlayStream, resourceLocatorRevision, type StoredPlayGrant } from '@library/catalog/catalogPlay'
import { readCatalogSetting, writeCatalogSetting } from '@library/catalog/catalogSettings'
import { closePlayStreams } from '@http/play'
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

function encodeTestMedia(filePath: string): void {
  const result = spawnSync(
    'ffmpeg',
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=6:size=320x240:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      filePath
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `ffmpeg failed for ${filePath}`)
  }
}

async function waitForPath(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`missing ${filePath}`)
}

function decodeMountPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))
}

function isBindMounted(mountPoint: string): boolean {
  let real = mountPoint
  try {
    real = fs.realpathSync.native(mountPoint)
  } catch {
    // The mount point should still exist after umount; ignore a vanished path.
  }
  const mounts = fs.readFileSync('/proc/self/mounts', 'utf8')
  return mounts.split('\n').some((line) => {
    const target = line.split(' ')[1]
    if (!target) return false
    const decoded = decodeMountPath(target)
    return decoded === mountPoint || decoded === real
  })
}

function bindMount(backing: string, mountPoint: string): void {
  fs.mkdirSync(backing, { recursive: true })
  fs.mkdirSync(mountPoint, { recursive: true })
  const result = spawnSync('sudo', ['-n', 'mount', '--bind', backing, mountPoint], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `mount --bind failed for ${mountPoint}`)
  }
  if (!isBindMounted(mountPoint)) {
    throw new Error(`bind mount missing from /proc/self/mounts: ${mountPoint}`)
  }
}

function unmountBind(mountPoint: string): void {
  if (!isBindMounted(mountPoint)) return
  const result = spawnSync('sudo', ['-n', 'umount', '--', mountPoint], { encoding: 'utf8' })
  if (result.status !== 0 && isBindMounted(mountPoint)) {
    spawnSync('sudo', ['-n', 'umount', '-l', '--', mountPoint], { encoding: 'utf8' })
  }
  if (isBindMounted(mountPoint)) {
    throw new Error(result.stderr || result.stdout || `umount failed for ${mountPoint}`)
  }
}

async function watchTestUnmount(instructionPath: string, mountPoint: string): Promise<void> {
  await waitForPath(`${instructionPath}.ready`, 30_000)
  unmountBind(mountPoint)
  assert.equal(isBindMounted(mountPoint), false)
  assert.equal(fs.existsSync(mountPoint), true)
  fs.writeFileSync(`${instructionPath}.done`, 'unmounted')
}

function startTcpRstProxy(targetPort: number): Promise<{
  port: number
  dropUpstreamToClient: () => void
  forwardUpstreamToClient: () => void
  droppedBytes: () => number
  resetAll: () => void
  close: () => Promise<void>
}> {
  const sockets = new Set<Socket>()
  let dropUpstream = false
  let dropped = 0
  const targetHost = `127.0.0.1:${targetPort}`
  const targetOrigin = `http://${targetHost}`
  const ignoreSocketError = (): void => undefined
  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('error', ignoreSocketError)
    socket.on('close', () => {
      sockets.delete(socket)
    })
  }
  const resetSocket = (socket: Socket): void => {
    try {
      socket.resetAndDestroy()
    } catch {
      socket.destroy()
    }
  }
  const server = createHttpServer((req, res) => {
    track(req.socket)
    const headers = { ...req.headers, host: targetHost, origin: targetOrigin }
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers
      },
      (upRes) => {
        if (dropUpstream) {
          upRes.on('data', (chunk) => {
            dropped += chunk.length
          })
          upRes.resume()
          return
        }
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      }
    )
    upstream.on('socket', (socket) => track(socket))
    upstream.on('error', ignoreSocketError)
    req.on('error', ignoreSocketError)
    res.on('error', ignoreSocketError)
    req.pipe(upstream)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('proxy port'))
        return
      }
      resolve({
        port: address.port,
        dropUpstreamToClient: () => {
          dropUpstream = true
        },
        forwardUpstreamToClient: () => {
          dropUpstream = false
        },
        droppedBytes: () => dropped,
        resetAll: () => {
          for (const socket of [...sockets]) resetSocket(socket)
        },
        close: () =>
          new Promise((done, fail) => {
            for (const socket of [...sockets]) resetSocket(socket)
            server.close((error) => (error ? fail(error) : done()))
          })
      })
    })
  })
}

async function mpvRpc(
  socketPath: string,
  command: unknown[],
  timeoutMs = 8_000
): Promise<{ error: string; data?: unknown }> {
  const requestId = Date.now() + Math.floor(Math.random() * 1_000)
  const payload = `${JSON.stringify({ command, request_id: requestId })}\n`
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`mpv timeout ${JSON.stringify(command)}`))
    }, timeoutMs)
    socket.on('connect', () => socket.write(payload))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { request_id?: number; error?: string; data?: unknown }
          if (parsed.request_id === requestId) {
            clearTimeout(timer)
            socket.end()
            resolve({ error: parsed.error ?? 'success', data: parsed.data })
            return
          }
        } catch {
          // Partial JSON line; wait for the rest.
        }
      }
      buffer = buffer.includes('\n') ? buffer.slice(buffer.lastIndexOf('\n') + 1) : buffer
    })
    socket.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function startMpv(socketPath: string): Promise<{
  child: ReturnType<typeof spawn>
  log: () => string
}> {
  fs.rmSync(socketPath, { force: true })
  const child = spawn(
    '/usr/bin/mpv',
    [
      '--vo=null',
      '--ao=null',
      '--idle=yes',
      '--force-window=no',
      '--keep-open=yes',
      '--no-config',
      '--osc=no',
      `--input-ipc-server=${socketPath}`
    ],
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const output: string[] = []
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')))
  }
  child.on('exit', () => {
    fs.rmSync(socketPath, { force: true })
  })
  await waitForPath(socketPath)
  return { child, log: () => output.join('') }
}

async function mpvTimePos(socketPath: string): Promise<number | null> {
  const result = await mpvRpc(socketPath, ['get_property', 'time-pos'])
  return typeof result.data === 'number' ? result.data : null
}

async function waitMpvTimePos(
  socketPath: string,
  predicate: (value: number) => boolean,
  timeoutMs = 8_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  let last: number | null = null
  while (Date.now() < deadline) {
    last = await mpvTimePos(socketPath)
    if (last != null && predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`mpv time-pos ${last} did not match`)
}

describe('server runtime lifecycle', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-server-runtime-')))
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
    delete process.env.JAVDEX_TEST_UMOUNT_SCAN
    delete process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE
  })

  after(() => {
    if (previousUserData === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previousUserData
    fs.rmSync(root, { recursive: true, force: true })
  })

  async function boot(
    dataDir: string,
    extraMounts: Record<string, string> = {},
    bind: { listenHost?: string; accessHosts?: string[] } = {}
  ): Promise<{ base: string; config: ServerConfig }> {
    process.env.JAVDEX_TEST_USER_DATA = dataDir
    const listenHost = bind.listenHost ?? '127.0.0.1'
    const accessHosts = bind.accessHosts ?? [listenHost]
    const config: ServerConfig = {
      listenHost,
      port: listenHost === '127.0.0.1' ? await freePort() : 0,
      accessHosts,
      dataDir,
      imagesDir: path.join(dataDir, 'media_assets'),
      staticRoot,
      mediaMounts: { library: mediaRoot, ...extraMounts },
      web: { username: 'viewer', passwordHash }
    }
    server = await startJavdexServer(config, { workerEntry })
    return { base: `http://${listenHost}:${server.port}`, config }
  }

  function addNonLoopbackListenHost(): { host: string; cleanup: () => void } {
    const requested = '10.67.67.1'
    const iface = Object.entries(os.networkInterfaces()).find(([, addrs]) =>
      (addrs ?? []).some(
        (item) => (item.family === 'IPv4' || (item.family as unknown) === 4) && !item.internal
      )
    )?.[0]
    if (!iface) throw new Error('no non-loopback IPv4 interface')
    const added = spawnSync('sudo', ['-n', 'ip', 'addr', 'add', `${requested}/32`, 'dev', iface], {
      encoding: 'utf8'
    })
    if (added.status === 0 || /File exists/i.test(added.stderr ?? '')) {
      return {
        host: requested,
        cleanup: () => {
          spawnSync('sudo', ['-n', 'ip', 'addr', 'del', `${requested}/32`, 'dev', iface], {
            encoding: 'utf8'
          })
        }
      }
    }
    const existing = (os.networkInterfaces()[iface] ?? []).find(
      (item) => (item.family === 'IPv4' || (item.family as unknown) === 4) && !item.internal
    )?.address
    if (!existing || existing.startsWith('127.')) {
      throw new Error(`cannot bind non-loopback address on ${iface}: ${added.stderr || added.stdout}`)
    }
    return { host: existing, cleanup: () => undefined }
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

  it('rejects escaped relative paths on files.importManual without leaking host paths', async () => {
    const dataDir = path.join(root, 'm02-import-escape')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId } = await insertBoundVideo('M02-BOUND')
    const rootRow = getDb()
      .prepare('SELECT id, real_path, path FROM media_library_roots WHERE library_id = 1')
      .get() as { id: number; real_path: string | null; path: string }
    const outside = path.join(root, 'm02-outside.mp4')
    fs.writeFileSync(outside, Buffer.from('outside-bytes'))
    const videosBefore = (
      getDb().prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }
    ).n
    const escaped = await postManage(
      base,
      'files.importManual',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {
          V: getDb()
            .prepare('SELECT generation, revision FROM videos WHERE id = ?')
            .get(videoId) as { generation: number; revision: number },
          R: { generation: 1, revision: 1 },
          G: { generation: 1, revision: 1 }
        },
        input: {
          libraryId: 1,
          location: { rootId: rootRow.id, relativePath: '../m02-outside.mp4' },
          code: 'M02-ESCAPE',
          target: { kind: 'new' }
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(escaped.status, 400, JSON.stringify(escaped.json))
    assert.equal((escaped.json as { code?: string }).code, 'INVALID_INPUT')
    const message = JSON.stringify(escaped.json)
    assert.doesNotMatch(message, /m02-outside/)
    assert.doesNotMatch(message, new RegExp(dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.doesNotMatch(message, /\/tmp\/|\/home\/|\/opt\//)
    assert.equal(
      (getDb().prepare('SELECT COUNT(*) AS n FROM videos').get() as { n: number }).n,
      videosBefore
    )
    assert.equal(
      getDb().prepare('SELECT id FROM videos WHERE code = ?').get('M02-ESCAPE') as { id: number } | undefined,
      undefined
    )
    assert.equal(fs.existsSync(outside), true)
  })

  it('returns per-target expire, success, and disconnect receipts without auto-overwriting', async () => {
    const dataDir = path.join(root, 'm07-partial')
    const stallPath = path.join(root, 'stall-videos-edit')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const expired = await insertBoundVideo('M07-EXPIRE', path.join(mediaRoot, 'm07-expire.mp4'))
    fs.writeFileSync(path.join(mediaRoot, 'm07-expire.mp4'), Buffer.from('expire'))
    const success = await insertBoundVideo('M07-OK', path.join(mediaRoot, 'm07-ok.mp4'))
    fs.writeFileSync(path.join(mediaRoot, 'm07-ok.mp4'), Buffer.from('ok-file'))
    const dropped = await insertBoundVideo('M07-DROP', path.join(mediaRoot, 'm07-drop.mp4'))
    fs.writeFileSync(path.join(mediaRoot, 'm07-drop.mp4'), Buffer.from('drop'))
    const versionOf = (videoId: number) =>
      getDb()
        .prepare('SELECT generation, revision FROM videos WHERE id = ?')
        .get(videoId) as { generation: number; revision: number }
    const expiredVersion = versionOf(expired.videoId)
    getDb()
      .prepare('UPDATE videos SET title = ?, revision = revision + 1 WHERE id = ?')
      .run('M07-EXPIRE-NOW', expired.videoId)
    const stale = await postManage(
      base,
      'videos.edit',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: expiredVersion },
        input: { videoId: expired.videoId, fields: { title: 'M07 should not apply' } }
      },
      { bearer: writer.secret }
    )
    assert.equal(stale.status, 409, JSON.stringify(stale.json))
    assert.equal((stale.json as { code?: string }).code, 'VERSION_CONFLICT')
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(expired.videoId) as { title: string }).title,
      'M07-EXPIRE-NOW'
    )

    const successVersion = versionOf(success.videoId)
    const successOp = randomUUID()
    const ok = await postManage(
      base,
      'videos.edit',
      {
        operationId: successOp,
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: successVersion },
        input: { videoId: success.videoId, fields: { title: 'M07 success' } }
      },
      { bearer: writer.secret }
    )
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
    const retryOk = await postManage(
      base,
      'videos.edit',
      {
        operationId: successOp,
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: successVersion },
        input: { videoId: success.videoId, fields: { title: 'M07 success' } }
      },
      { bearer: writer.secret }
    )
    assert.equal(retryOk.status, 200, JSON.stringify(retryOk.json))
    assert.equal((retryOk.json as { receipt?: { status?: string } }).receipt?.status, 'duplicate')
    assert.equal(
      (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(success.videoId) as { title: string }).title,
      'M07 success'
    )

    const credentials = {
      async isAvailable() {
        return true
      },
      async readWriterSecret(catalogId: string) {
        return catalogId === writer.catalogId ? writer.secret : null
      },
      async writeWriterSecret() {
        return
      },
      async deleteWriterSecret() {
        return
      }
    }
    const backend = createRemoteCatalogBackend({
      baseUrl: base,
      appVersion: SERVER_APP_VERSION,
      credentials
    })
    const previousStall = process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT
    const previousStallMs = process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_MS
    process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT = stallPath
    process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_MS = '800'
    fs.writeFileSync(stallPath, '1')
    const dropOp = randomUUID()
    const dropVersion = versionOf(dropped.videoId)
    const abort = new AbortController()
    try {
      const pending = backend.videos.edit(
        { videoId: dropped.videoId, fields: { title: 'M07 after disconnect' } },
        { operationId: dropOp, expectedVersions: { V: dropVersion }, signal: abort.signal }
      )
      await waitForPath(`${stallPath}.started`, 10_000)
      abort.abort()
      await assert.rejects(
        () => pending,
        (error: unknown) => isStructuredError(error) && error.code === 'CONNECTION_UNAVAILABLE'
      )
      const receipt = (await backend.tasks.getOperation({ operationId: dropOp })) as {
        status: string
        operationId: string
      }
      assert.equal(receipt.operationId, dropOp)
      assert.equal(receipt.status, 'applied')
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(dropped.videoId) as { title: string })
          .title,
        'M07 after disconnect'
      )
      const retryDrop = await backend.videos.edit(
        { videoId: dropped.videoId, fields: { title: 'M07 after disconnect' } },
        { operationId: dropOp, expectedVersions: { V: dropVersion } }
      )
      assert.equal(retryDrop, true)
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(dropped.videoId) as { title: string })
          .title,
        'M07 after disconnect'
      )
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(expired.videoId) as { title: string }).title,
        'M07-EXPIRE-NOW'
      )
      await new Promise((resolve) => setTimeout(resolve, 900))
    } finally {
      if (previousStall === undefined) delete process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT
      else process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT = previousStall
      if (previousStallMs === undefined) delete process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_MS
      else process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_MS = previousStallMs
      await backend.dispose()
    }
  })

  it('rejects an in-flight videos.edit after a new writer is claimed during the pause', async () => {
    const dataDir = path.join(root, 'm06-handoff')
    const stallPath = path.join(root, 'stall-videos-edit-before')
    fs.rmSync(stallPath, { force: true })
    fs.rmSync(`${stallPath}.started`, { force: true })
    fs.rmSync(`${stallPath}.done`, { force: true })
    const previous = process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE
    process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE = stallPath
    fs.writeFileSync(stallPath, '1')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const paused = await insertBoundVideo('M06-PAUSE', path.join(mediaRoot, 'm06-pause.mp4'))
    fs.writeFileSync(path.join(mediaRoot, 'm06-pause.mp4'), Buffer.from('pause'))
    const version = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(paused.videoId) as { generation: number; revision: number }
    const operationId = randomUUID()
    try {
      const pending = postManage(
        base,
        'videos.edit',
        {
          operationId,
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          expectedVersions: { V: version },
          input: { videoId: paused.videoId, fields: { title: 'M06 should not apply' } }
        },
        { bearer: writer.secret }
      )
      await waitForPath(`${stallPath}.started`)
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
      assert.equal((consumed.json as { status: string }).status, 'consumed')
      const nextEpoch = (consumed.json as { writerEpoch: number }).writerEpoch
      assert.ok(nextEpoch > writer.writerEpoch)
      fs.writeFileSync(`${stallPath}.done`, '1')
      const pausedResult = await pending
      assert.equal(pausedResult.status, 409, JSON.stringify(pausedResult.json))
      assert.equal((pausedResult.json as { code?: string }).code, 'WRITER_REVOKED')
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(paused.videoId) as { title: string }).title,
        'M06-PAUSE'
      )
      const receipt = await postManage(
        base,
        'operations.get',
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: nextEpoch,
          input: { operationId }
        },
        { bearer: nextSecret }
      )
      assert.equal(receipt.status, 200, JSON.stringify(receipt.json))
      assert.equal((receipt.json as { status?: string }).status, 'unknown')
      const applied = await postManage(
        base,
        'videos.edit',
        {
          operationId: randomUUID(),
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: nextEpoch,
          expectedVersions: { V: version },
          input: { videoId: paused.videoId, fields: { title: 'M06 after claim' } }
        },
        { bearer: nextSecret }
      )
      assert.equal(applied.status, 200, JSON.stringify(applied.json))
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(paused.videoId) as { title: string }).title,
        'M06 after claim'
      )
    } finally {
      if (previous === undefined) delete process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE
      else process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE = previous
      fs.writeFileSync(`${stallPath}.done`, '1')
    }
  })

  it('rejects handoff while a scan runs and lets the user retry after completion', async () => {
    const mount = path.join(root, 'm06-scan-media')
    fs.mkdirSync(mount, { recursive: true })
    fs.writeFileSync(path.join(mount, 'M06-001.mp4'), Buffer.from('0123456789abcdef'))
    const dataDir = path.join(root, 'm06-scan-handoff')
    const instructionDir = path.join(dataDir, 'unmount-instructions')
    fs.mkdirSync(instructionDir, { recursive: true })
    const instructionPath = path.join(instructionDir, 'after-enumerate.json')
    const previousUnmount = process.env.JAVDEX_TEST_UMOUNT_SCAN
    const { base, config } = await boot(dataDir, { m06scan: mount })
    const writer = await claimInitialWriter(base, config)
    let epoch = writer.writerEpoch
    let secret = writer.secret
    const versions = (library: { revision: number; config: { revision: number } }) => ({
      L: { generation: 1, revision: library.revision },
      C: { generation: 1, revision: library.config.revision },
      G: { generation: 1, revision: 1 },
      V: { generation: 1, revision: 1 },
      R: { generation: 1, revision: 1 }
    })
    const write = async (operation: string, expectedVersions: unknown, input: unknown) =>
      postManage(
        base,
        operation,
        {
          operationId: randomUUID(),
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: epoch,
          expectedVersions,
          input
        },
        { bearer: secret }
      )
    const read = async (operation: string, input: unknown) =>
      postManage(
        base,
        operation,
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: epoch,
          input
        },
        { bearer: secret }
      )
    const pollTask = async (taskId: string, timeoutMs = 60_000) => {
      const startedAt = Date.now()
      let last: { state: string } | undefined
      while (Date.now() - startedAt < timeoutMs) {
        const result = await read('tasks.get', { taskId })
        assert.equal(result.status, 200)
        last = result.json as { state: string }
        if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
    }
    try {
      let library = (await read('libraries.get', { libraryId: 1 })).json as {
        revision: number
        config: { revision: number }
      }
      const configUpdated = await write('libraries.updateConfig', versions(library), {
        libraryId: 1,
        patch: { minImportDurationMinutes: 0 }
      })
      assert.equal(configUpdated.status, 200, JSON.stringify(configUpdated.json))
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const added = await write('libraries.addRoot', versions(library), {
        libraryId: 1,
        root: { mountSelectionId: 'm06scan' }
      })
      assert.equal(added.status, 200, JSON.stringify(added.json))
      fs.writeFileSync(instructionPath, JSON.stringify({ phase: 'afterEnumerate' }))
      process.env.JAVDEX_TEST_UMOUNT_SCAN = instructionPath
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const started = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(started.status, 200, JSON.stringify(started.json))
      await waitForPath(`${instructionPath}.ready`, 30_000)
      const handoff = await write('writer.handoffBegin', {}, {})
      assert.equal(handoff.status, 200, JSON.stringify(handoff.json))
      const nextSecret = generateSecret()
      const claimId = randomUUID()
      const candidate = { claimId, secretDigest: digestToken(nextSecret) }
      const waiting = await postManage(base, 'writer.claim', {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: {
          kind: 'handoff',
          oneTimeToken: (handoff.json as { oneTimeToken: string }).oneTimeToken,
          candidate
        }
      })
      assert.equal(waiting.status, 409, JSON.stringify(waiting.json))
      assert.equal((waiting.json as { code: string }).code, 'MAINTENANCE_BUSY')
      const overlap = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(overlap.status, 409, JSON.stringify(overlap.json))
      assert.equal((overlap.json as { code?: string }).code, 'MAINTENANCE_BUSY')
      fs.writeFileSync(`${instructionPath}.done`, '1')
      const finished = await pollTask((started.json as { taskId: string }).taskId)
      assert.equal(finished.state, 'succeeded', JSON.stringify(finished))
      const status = await read('writer.status', {})
      assert.equal(status.status, 200, JSON.stringify(status.json))
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const unblocked = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(unblocked.status, 200, JSON.stringify(unblocked.json))
      assert.equal((await pollTask((unblocked.json as { taskId: string }).taskId)).state, 'succeeded')
      const consumed = await postManage(base, 'writer.claim', {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: {
          kind: 'handoff',
          oneTimeToken: (handoff.json as { oneTimeToken: string }).oneTimeToken,
          candidate
        }
      })
      assert.equal(consumed.status, 200, JSON.stringify(consumed.json))
      assert.equal((consumed.json as { status: string }).status, 'consumed')
      const nextEpoch = (consumed.json as { writerEpoch: number }).writerEpoch
      assert.ok(nextEpoch > epoch)
      epoch = nextEpoch
      secret = nextSecret
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const nextScan = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(nextScan.status, 200, JSON.stringify(nextScan.json))
      const nextTask = await pollTask((nextScan.json as { taskId: string }).taskId)
      assert.equal(nextTask.state, 'succeeded', JSON.stringify(nextTask))
      const oldSecret = await postManage(
        base,
        'videos.edit',
        {
          operationId: randomUUID(),
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          expectedVersions: { V: { generation: 1, revision: 1 } },
          input: { videoId: 1, fields: { title: 'should not apply' } }
        },
        { bearer: writer.secret }
      )
      assert.equal(oldSecret.status, 401, JSON.stringify(oldSecret.json))
      assert.equal((oldSecret.json as { code?: string }).code, 'AUTH_REQUIRED')
      const staleEpoch = await postManage(
        base,
        'videos.edit',
        {
          operationId: randomUUID(),
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          expectedVersions: { V: { generation: 1, revision: 1 } },
          input: { videoId: 1, fields: { title: 'should not apply' } }
        },
        { bearer: nextSecret }
      )
      assert.equal(staleEpoch.status, 409, JSON.stringify(staleEpoch.json))
      assert.equal((staleEpoch.json as { code?: string }).code, 'WRITER_REVOKED')
    } finally {
      if (previousUnmount === undefined) delete process.env.JAVDEX_TEST_UMOUNT_SCAN
      else process.env.JAVDEX_TEST_UMOUNT_SCAN = previousUnmount
      fs.writeFileSync(`${instructionPath}.done`, '1')
    }
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
      assert.equal(backend.capabilities().migrateCatalog.allowed, true)
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

  it('lets manage read hidden, archived, memberless, actress, playlist, and pending images that web cannot', async () => {
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
    const orphanId = Number(
      getDb()
        .prepare(
          `INSERT INTO videos (code, title, scraped_status, add_time)
           VALUES ('M01-ORPHAN', 'M01-ORPHAN', 0, ?)`
        )
        .run(new Date().toISOString()).lastInsertRowid
    )
    const independentId = upsertActressFromScrape('Independent Star', null, 'female')
    const png = await sharp({
      create: { width: 10, height: 8, channels: 3, background: { r: 20, g: 40, b: 80 } }
    })
      .png()
      .toBuffer()
    const staged = mediaAssetStore.stageVideoScrapeImages([
      { field: 'cover', position: 0, remoteUrl: 'https://example.test/m01-cover.png', data: png }
    ])
    const pending = replacePendingVideoScrape({
      videoId,
      selectedFields: ['cover'],
      applicableFields: ['cover'],
      updateMode: 'replace',
      request: { source: 'm01-scope' },
      warnings: [],
      sources: [
        {
          pluginName: 'm01',
          pluginSource: 'builtin',
          pluginVersion: '1',
          pluginConfig: {},
          sourceName: 'm01',
          selectedFields: ['cover'],
          candidates: [
            {
              result: { code: 'M01-HIDDEN', coverUrl: 'https://example.test/m01-cover.png' },
              sourceUrl: 'https://example.test/m01-hidden',
              normalizedSourceUrl: 'https://example.test/m01-hidden',
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
    const stagedPath = staged[0]!.stagedPath

    const cookie = (await login(base, password, true)).cookie
    const webDetail = await fetch(`${base}/api/videos/${videoId}`, { headers: { Cookie: cookie } })
    assert.equal(webDetail.status, 404)
    const webOrphan = await fetch(`${base}/api/videos/${orphanId}`, { headers: { Cookie: cookie } })
    assert.equal(webOrphan.status, 404)
    const webBrowse = await fetch(`${base}/api/videos?q=M01-HIDDEN`, { headers: { Cookie: cookie } })
    assert.equal(webBrowse.status, 200)
    const browseBody = (await webBrowse.json()) as { items?: Array<{ id: number }> }
    assert.equal((browseBody.items ?? []).some((item) => item.id === videoId), false)
    const webOrphanBrowse = await fetch(`${base}/api/videos?q=M01-ORPHAN`, { headers: { Cookie: cookie } })
    assert.equal(webOrphanBrowse.status, 200)
    const orphanBrowse = (await webOrphanBrowse.json()) as { items?: Array<{ id: number }> }
    assert.equal((orphanBrowse.items ?? []).some((item) => item.id === orphanId), false)
    const webActress = await fetch(`${base}/api/videos?q=${encodeURIComponent('Independent Star')}`, {
      headers: { Cookie: cookie }
    })
    assert.equal(webActress.status, 200)
    const actressBrowse = (await webActress.json()) as { items?: Array<{ id: number }> }
    assert.equal((actressBrowse.items ?? []).length, 0)
    const collections = await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })
    assert.equal(collections.status, 200)
    const collectionBody = (await collections.json()) as {
      libraries: Array<{ id: number; name: string }>
      playlists: Array<{ id: number; name: string }>
    }
    assert.equal(collectionBody.libraries.some((library) => library.id === archivedId), false)
    const webPendingImage = await fetch(`${base}/api/videos/${videoId}/images/cover`, {
      headers: { Cookie: cookie }
    })
    assert.equal(webPendingImage.status, 404)
    const cookiePendingAsset = await fetch(`${base}/manage/v1/assets/${stagedPath}`, {
      headers: {
        Origin: base,
        Cookie: cookie,
        'X-Javdex-App-Version': SERVER_APP_VERSION
      }
    })
    assert.equal(cookiePendingAsset.status, 401)
    const cookieManage = await postManage(
      base,
      'videos.get',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { scope: { kind: 'all' }, videoId }
      },
      { cookie }
    )
    assert.equal(cookieManage.status, 401)

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
      const orphan = (await backend.queries.getVideo({
        scope: { kind: 'all' },
        videoId: orphanId
      })) as { id: number; title: string; code?: string }
      assert.equal(orphan.id, orphanId)
      assert.equal(orphan.title, 'M01-ORPHAN')
      const libraries = (await backend.libraries.list({ includeArchived: true })) as Array<{
        id: number
        status: string
      }>
      assert.equal(libraries.some((library) => library.id === archivedId && library.status === 'archived'), true)
      const actress = (await backend.actresses.get({ actressId: independentId })) as {
        id: number
        main_name: string
      }
      assert.equal(actress.id, independentId)
      assert.equal(actress.main_name, 'Independent Star')
      const playlist = { playlistId: await backend.playlists.create(
        { name: 'M01 Hidden List' },
        { operationId: randomUUID(), expectedVersions: {} }
      ) }
      await backend.playlists.addVideo(
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
      const created = (await backend.playlists.get({ playlistId: playlist.playlistId })) as {
        name?: string
        videos?: Array<{ id: number }>
      }
      assert.equal(created?.name, 'M01 Hidden List', JSON.stringify(created))
      assert.equal(created?.videos?.some((video) => video.id === videoId), true, JSON.stringify(created))
      const collectionsAfter = await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })
      assert.equal(collectionsAfter.status, 200)
      const collectionsAfterBody = (await collectionsAfter.json()) as {
        playlists: Array<{ id: number; name: string }>
      }
      assert.equal(
        collectionsAfterBody.playlists.some((row) => row.id === playlist.playlistId),
        false
      )
      const pendingRow = (await backend.pendingVideoScrapes.get({
        pendingScrapeId: pending.pendingScrapeId
      })) as { id?: number } | null
      assert.equal(pendingRow?.id, pending.pendingScrapeId, JSON.stringify(pendingRow))
      const managePendingImage = await fetch(`${base}/manage/v1/assets/${stagedPath}`, {
        headers: {
          Origin: base,
          Authorization: `Bearer ${writer.secret}`,
          'X-Javdex-App-Version': SERVER_APP_VERSION
        }
      })
      assert.equal(managePendingImage.status, 200, await managePendingImage.text())
      assert.match(managePendingImage.headers.get('content-type') ?? '', /image\/png/)
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
      })) as { rating: number; title: string; revision: number }
      const localDetail = (await local.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { rating: number; title: string; revision: number }
      assert.equal(remoteDetail.rating, 4)
      assert.equal(localDetail.rating, 4)
      const afterRating = getDb()
        .prepare('SELECT generation, revision FROM videos WHERE id = ?')
        .get(videoId) as { generation: number; revision: number }
      assert.equal(afterRating.generation, version.generation)
      assert.equal(afterRating.revision, version.revision + 1)
      assert.equal(remoteDetail.revision, afterRating.revision)
      assert.equal(localDetail.revision, afterRating.revision)

      await assert.rejects(
        () =>
          remote.videos.edit(
            { videoId, fields: { title: 'Stale after rating' } },
            { operationId: randomUUID(), expectedVersions: { V: version } }
          ),
        (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT'
      )

      const titled = await remote.videos.edit(
        { videoId, fields: { title: 'Rated then titled' } },
        { operationId: randomUUID(), expectedVersions: { V: afterRating } }
      )
      assert.equal(titled, true)
      const afterTitle = (await remote.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string; revision: number }
      assert.equal(afterTitle.title, 'Rated then titled')
      assert.equal(afterTitle.revision, afterRating.revision + 1)

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

      const playlist = { playlistId: await remote.playlists.create(
        { name: 'S08 List' },
        { operationId: randomUUID(), expectedVersions: {} }
      ) }
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

  for (const pending of [false, true]) it(`imports NFO metadata and local images through a real server scan (pending=${pending}) and rejects stale edits`, async () => {
    const mount = fs.realpathSync(fs.mkdtempSync(path.join(root, 'nfo-import-')))
    fs.writeFileSync(path.join(mount, 'NFO-901.strm'), 'https://example.test/movie.mp4')
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } }).png().toBuffer()
    for (const name of ['poster.png', 'sample.png', 'actor.png']) fs.writeFileSync(path.join(mount, name), png)
    fs.writeFileSync(path.join(mount, 'NFO-901.nfo'), `<movie><num>NFO-901</num><title>Imported title</title>
      <plot>Imported summary</plot><tag>NFO tag</tag><thumb aspect="poster">poster.png</thumb>
      <fanart><thumb>sample.png</thumb></fanart><actor><name>NFO actor</name><thumb>actor.png</thumb></actor></movie>`)
    if (pending) {
      fs.copyFileSync(path.join(mount, 'NFO-901.strm'), path.join(mount, 'NFO-901-CD2.strm'))
      fs.copyFileSync(path.join(mount, 'NFO-901.nfo'), path.join(mount, 'NFO-901-CD2.nfo'))
    }
    const { base, config } = await boot(path.join(root, `nfo-import-data-${pending}`), { nfo: mount })
    const writer = await claimInitialWriter(base, config)
    const remote = createRemoteCatalogBackend({ baseUrl: base, appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]])) })
    await remote.reconnect()
    const write = (operation: string, input: unknown, expectedVersions: unknown = {}) => postManage(base, operation, {
      serverId: writer.serverId, catalogId: writer.catalogId, writerEpoch: writer.writerEpoch,
      operationId: randomUUID(), expectedVersions, input
    }, { bearer: writer.secret })
    const library = getDb().prepare('SELECT revision FROM media_libraries WHERE id=1').get() as { revision: number }
    const cfg = getDb().prepare('SELECT revision FROM media_library_configs WHERE library_id=1').get() as { revision: number }
    const versions = { L: { generation: 1, revision: library.revision }, C: { generation: 1, revision: cfg.revision }, G: { generation: 1, revision: 1 } }
    try {
      const changed = await write('libraries.updateConfig', { libraryId: 1, patch: { autoImportLocalNfo: true, autoMergeSameCodeResources: true, minImportDurationMinutes: 0 } }, versions)
      assert.equal(changed.status, 200, JSON.stringify(changed.json))
      const current = await remote.libraries.get({ libraryId: 1 })
      assert.ok(current)
      const updatedVersions = { ...versions, L: { generation: 1, revision: current.revision }, C: { generation: 1, revision: current.config.revision } }
      const added = await write('libraries.addRoot', { libraryId: 1, root: { mountSelectionId: 'nfo' } }, updatedVersions)
      assert.equal(added.status, 200, JSON.stringify(added.json))
      const id = Number(getDb().prepare("INSERT INTO videos(code) VALUES ('NFO-901')").run().lastInsertRowid)
      const old = getDb().prepare('SELECT generation,revision FROM videos WHERE id=?').get(id)
      const fresh = await remote.libraries.get({ libraryId: 1 })
      assert.ok(fresh)
      const started = await write('scans.run', { libraryId: 1 }, { ...updatedVersions, L: { generation: 1, revision: fresh.revision }, C: { generation: 1, revision: fresh.config.revision } })
      assert.equal(started.status, 200, JSON.stringify(started.json))
      const taskId = (started.json as { taskId: string }).taskId
      let state = ''
      for (let n = 0; n < 250; n++) {
        const task = await remote.tasks.get({ taskId })
        state = task.state
        if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(state)) break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.equal(state, 'succeeded')
      if (pending) {
        const row = getDb().prepare('SELECT id FROM pending_video_scrapes WHERE video_id=?').get(id) as { id: number }
        const candidate = getPendingVideoScrapeById(row.id)!
        assert.equal(candidate.sources[0].candidates.length, 2)
        assert.equal((getDb().prepare('SELECT title FROM videos WHERE id=?').get(id) as { title: string | null }).title, null)
        const confirmed = await write('pendingVideoScrapes.confirm', {
          pendingScrapeId: row.id, selections: [{ sourceId: candidate.sources[0].id, candidateId: candidate.sources[0].candidates[0].id }]
        }, { V: old, Q: { generation: 1, revision: candidate.revision } })
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
        assert.equal((confirmed.json as { applied: boolean }).applied, true)
      }
      const video = getDb().prepare('SELECT title,summary,cover_path,revision FROM videos WHERE id=?').get(id) as { title: string; summary: string; cover_path: string; revision: number }
      assert.equal(video.title, 'Imported title')
      assert.equal(video.summary, 'Imported summary')
      assert.ok(fs.existsSync(path.join(config.imagesDir, video.cover_path)))
      const samples = getDb().prepare("SELECT local_path FROM video_assets WHERE video_id=? AND type='sample'").all(id) as { local_path: string }[]
      assert.equal(samples.length, 1)
      assert.ok(fs.existsSync(path.join(config.imagesDir, samples[0].local_path)))
      const actor = getDb().prepare("SELECT avatar_path FROM actresses WHERE main_name='NFO actor'").get() as { avatar_path: string }
      assert.ok(fs.existsSync(path.join(config.imagesDir, actor.avatar_path)))
      const stale = await write('videos.edit', { videoId: id, fields: { title: 'Stale title' } }, { V: old })
      assert.equal(stale.status, 409, JSON.stringify(stale.json))
      assert.equal((stale.json as { code: string }).code, 'VERSION_CONFLICT')
    } finally { remote.dispose() }
  })

  it('pairs a browser through the remote backend, persists its device and revokes access', async () => {
    const { base, config } = await boot(path.join(root, 'remote-pairing'))
    const writer = await claimInitialWriter(base, config)
    const remote = createRemoteCatalogBackend({ baseUrl: base, appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]])) })
    await remote.reconnect()
    const mutation = () => ({ operationId: randomUUID(), expectedVersions: {} })
    const web = (endpoint: string, body: unknown, cookie?: string) => fetch(`${base}${endpoint}`, {
      method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Javdex-Client': 'web', ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body)
    })
    try {
      await remote.browser.pairOpen({}, mutation())
      const denied = await web('/api/pair/start', { name: 'Denied device', remember: true })
      const deniedCookie = denied.headers.get('set-cookie')!.split(';')[0]
      const deniedPair = await denied.json() as { code: string }
      await remote.browser.pairDecide({ code: deniedPair.code, decision: 'deny' }, mutation())
      const deniedPoll = await web('/api/pair/poll', {}, deniedCookie)
      assert.notEqual((await deniedPoll.json() as { authenticated?: boolean }).authenticated, true)
      const requested = await web('/api/pair/start', { name: 'Test phone', remember: true })
      assert.equal(requested.status, 200)
      const pairCookie = requested.headers.get('set-cookie')!.split(';')[0]
      const pair = await requested.json() as { code: string }
      const inspected = await remote.browser.pairInspect({ code: pair.code })
      assert.match(inspected.name, /Test phone/)
      await remote.browser.pairDecide({ code: pair.code, decision: 'approve' }, mutation())
      const poll = await web('/api/pair/poll', {}, pairCookie)
      assert.equal(poll.status, 200)
      assert.equal((await poll.json() as { authenticated: boolean }).authenticated, true)
      const cookie = poll.headers.get('set-cookie')!.split(';')[0]
      assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 200)
      assert.equal((await postManage(base, 'browser.pairOpen', {
        serverId: writer.serverId, catalogId: writer.catalogId, writerEpoch: writer.writerEpoch,
        operationId: randomUUID(), expectedVersions: {}, input: {}
      }, { cookie })).status, 401)
      const device = (await remote.browser.status({})).devices[0]
      assert.ok(device)
      await remote.browser.deviceRename({ deviceId: device.id, name: 'Paired phone' }, mutation())
      await server!.stop()
      server = await startJavdexServer(config, { workerEntry })
      await remote.reconnect()
      assert.equal((await remote.browser.status({})).devices[0].name, 'Paired phone')
      assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 200)
      await remote.browser.deviceRemove({ deviceId: device.id }, mutation())
      assert.equal((await fetch(`${base}/api/collections`, { headers: { Cookie: cookie } })).status, 401)
    } finally { remote.dispose() }
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
      const previewResult = await read('files.renamePreview', {
        libraryId: 1,
        location,
        newFileName: 'ABC-001-renamed.mp4'
      })
      assert.equal(previewResult.status, 200, JSON.stringify(previewResult.json))
      const preview = previewResult.json as { planDigest: string; expectedVersions: unknown }
      const renamed = await write('files.rename', preview.expectedVersions, {
        libraryId: 1,
        resourceId: resource.id,
        location,
        newFileName: 'ABC-001-renamed.mp4',
        planId: randomUUID(),
        planDigest: preview.planDigest
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

  it('treats a real bind-mount umount as offline, distinct from marker loss and missing files', async () => {
    const backing = path.join(root, 'm08-backing')
    const mountPoint = path.join(root, 'm08-mnt')
    bindMount(backing, mountPoint)
    const dataDir = path.join(root, 'm08-bind-umount')
    const instructionDir = path.join(dataDir, 'unmount-instructions')
    fs.mkdirSync(instructionDir, { recursive: true })
    const previousUnmount = process.env.JAVDEX_TEST_UMOUNT_SCAN
    const { base, config } = await boot(dataDir, { m08: mountPoint })
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
    const write = async (operation: string, expectedVersions: unknown, input: unknown) =>
      postManage(base, operation, envelope(randomUUID(), expectedVersions, input), { bearer: writer.secret })
    const read = async (operation: string, input: unknown) =>
      postManage(base, operation, {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input
      }, { bearer: writer.secret })
    const pollTask = async (taskId: string, timeoutMs = 60_000) => {
      const startedAt = Date.now()
      let last: { state: string } | undefined
      while (Date.now() - startedAt < timeoutMs) {
        const result = await read('tasks.get', { taskId })
        assert.equal(result.status, 200)
        last = result.json as { state: string }
        if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
    }
    const latestOffline = async (): Promise<string[]> => {
      const latest = (await read('scans.getLatest', { libraryId: 1 })).json as {
        summary?: { offlineFolders?: string[] }
        offlineFolders?: string[]
      }
      return latest.summary?.offlineFolders ?? latest.offlineFolders ?? []
    }
    const resourceCount = (code: string) =>
      (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n
               FROM video_resources resource
               JOIN videos video ON video.id = resource.video_id
              WHERE video.code = ? AND resource.library_id = 1`
          )
          .get(code) as { n: number }
      ).n
    const armUnmount = async (
      instructionName: string,
      body: { phase: string; kind?: string; afterPages?: number }
    ) => {
      const instructionPath = path.join(instructionDir, instructionName)
      fs.rmSync(instructionPath, { force: true })
      fs.rmSync(`${instructionPath}.ready`, { force: true })
      fs.rmSync(`${instructionPath}.done`, { force: true })
      fs.writeFileSync(instructionPath, JSON.stringify(body))
      process.env.JAVDEX_TEST_UMOUNT_SCAN = instructionPath
      return { instructionPath, watch: watchTestUnmount(instructionPath, mountPoint) }
    }
    const runScan = async () => {
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const started = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(started.status, 200, JSON.stringify(started.json))
      const task = await pollTask((started.json as { taskId: string }).taskId)
      assert.equal(task.state, 'succeeded', JSON.stringify(task))
      return task
    }

    let library = (await read('libraries.get', { libraryId: 1 })).json as {
      revision: number
      config: { revision: number }
      roots: Array<{ id: number; path: string }>
    }
    try {
      const configUpdated = await write('libraries.updateConfig', versions(library), {
        libraryId: 1,
        patch: { minImportDurationMinutes: 0 }
      })
      assert.equal(configUpdated.status, 200)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library

      const added = await write('libraries.addRoot', versions(library), {
        libraryId: 1,
        root: { mountSelectionId: 'm08' }
      })
      assert.equal(added.status, 200, JSON.stringify(added.json))
      const addedRoot = added.json as { id: number; path: string }
      assert.equal(isBindMounted(mountPoint), true)
      assert.equal(fs.existsSync(path.join(mountPoint, JAVDEX_ROOT_MARKER)), true)
      assert.equal(fs.existsSync(path.join(backing, JAVDEX_ROOT_MARKER)), true)
      fs.writeFileSync(path.join(mountPoint, 'KEEP-001.mp4'), Buffer.from('0123456789abcdef'))
      fs.writeFileSync(path.join(mountPoint, 'GONE-001.mp4'), Buffer.from('0123456789abcdef'))
      const markerStat = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))

      await runScan()
      assert.equal(
        (getDb().prepare("SELECT code FROM videos WHERE code = 'KEEP-001'").get() as { code: string } | undefined)?.code,
        'KEEP-001'
      )
      assert.equal(
        (getDb().prepare("SELECT code FROM videos WHERE code = 'GONE-001'").get() as { code: string } | undefined)?.code,
        'GONE-001'
      )
      assert.equal(resourceCount('KEEP-001'), 1)
      assert.equal(resourceCount('GONE-001'), 1)
      assert.equal((await latestOffline()).length, 0)

      const afterEnumerate = await armUnmount('after-enumerate.json', { phase: 'afterEnumerate' })
      await runScan()
      await afterEnumerate.watch
      const afterEnumerateOffline = await latestOffline()
      assert.equal(
        afterEnumerateOffline.some((folder) => folder === addedRoot.path || folder === mountPoint),
        true,
        JSON.stringify(afterEnumerateOffline)
      )
      assert.equal(isBindMounted(mountPoint), false)
      assert.equal(fs.existsSync(mountPoint), true)
      assert.equal(fs.existsSync(path.join(mountPoint, JAVDEX_ROOT_MARKER)), false)
      assert.equal(fs.existsSync(path.join(backing, JAVDEX_ROOT_MARKER)), true)
      assert.equal(resourceCount('KEEP-001'), 1)
      assert.equal(resourceCount('GONE-001'), 1)
      bindMount(backing, mountPoint)
      const remountedMarker = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))
      assert.equal(remountedMarker.ino, markerStat.ino)
      assert.equal(Math.round(remountedMarker.mtimeMs), Math.round(markerStat.mtimeMs))

      fs.unlinkSync(path.join(backing, 'GONE-001.mp4'))
      const beforeCleanup = await armUnmount('before-cleanup.json', {
        phase: 'beforeCleanupPage',
        kind: 'resources',
        afterPages: 0
      })
      await runScan()
      await beforeCleanup.watch
      const beforeCleanupOffline = await latestOffline()
      assert.equal(
        beforeCleanupOffline.some((folder) => folder === addedRoot.path || folder === mountPoint),
        true,
        JSON.stringify(beforeCleanupOffline)
      )
      assert.equal(isBindMounted(mountPoint), false)
      assert.equal(fs.existsSync(mountPoint), true)
      assert.equal(resourceCount('KEEP-001'), 1)
      assert.equal(resourceCount('GONE-001'), 1, 'unmount before cleanup must not treat backing files as deleted')
      bindMount(backing, mountPoint)

      await runScan()
      assert.equal((await latestOffline()).length, 0)
      assert.equal(resourceCount('KEEP-001'), 1)
      assert.equal(resourceCount('GONE-001'), 0)
      assert.equal(fs.existsSync(path.join(backing, JAVDEX_ROOT_MARKER)), true)
      const afterMissingMarker = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))
      assert.equal(afterMissingMarker.ino, markerStat.ino)

      const keepResource = getDb()
        .prepare(
          `SELECT resource.id AS id, resource.locator AS locator
             FROM video_resources resource
             JOIN videos video ON video.id = resource.video_id
            WHERE resource.library_id = 1 AND video.code = 'KEEP-001'
            LIMIT 1`
        )
        .get() as { id: number; locator: string }
      const location = {
        rootId: addedRoot.id,
        relativePath: path.relative(mountPoint, keepResource.locator) || path.basename(keepResource.locator)
      }
      const digest = filesRenameDigest({
        libraryId: 1,
        resourceId: keepResource.id,
        location,
        newFileName: 'KEEP-001-renamed.mp4'
      })
      unmountBind(mountPoint)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const renamedWhileUnmounted = await write('files.rename', versions(library), {
        libraryId: 1,
        resourceId: keepResource.id,
        location,
        newFileName: 'KEEP-001-renamed.mp4',
        planId: randomUUID(),
        planDigest: digest
      })
      assert.equal(renamedWhileUnmounted.status, 409, JSON.stringify(renamedWhileUnmounted.json))
      assert.equal((renamedWhileUnmounted.json as { code?: string }).code, 'VERSION_CONFLICT')
      assert.equal(fs.existsSync(path.join(backing, 'KEEP-001.mp4')), true)
      assert.equal(fs.existsSync(path.join(backing, 'KEEP-001-renamed.mp4')), false)
      assert.equal(resourceCount('KEEP-001'), 1)
      bindMount(backing, mountPoint)
      const recoveredMarker = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))
      assert.equal(recoveredMarker.ino, markerStat.ino)
      assert.equal(fs.existsSync(path.join(mountPoint, JAVDEX_ROOT_MARKER)), true)
      assert.equal(fs.existsSync(path.join(mountPoint, 'KEEP-001.mp4')), true)
    } finally {
      if (previousUnmount === undefined) delete process.env.JAVDEX_TEST_UMOUNT_SCAN
      else process.env.JAVDEX_TEST_UMOUNT_SCAN = previousUnmount
      try {
        unmountBind(mountPoint)
      } catch {
        // Keep the suite able to delete the temp tree even if umount already ran.
      }
    }
  })

  it('keeps the next cleanup page when a real bind mount is unmounted between pages', async () => {
    const backing = path.join(root, 'm08-page-backing')
    const mountPoint = path.join(root, 'm08-page-mnt')
    bindMount(backing, mountPoint)
    const dataDir = path.join(root, 'm08-bind-umount-pages')
    const instructionDir = path.join(dataDir, 'unmount-instructions')
    fs.mkdirSync(instructionDir, { recursive: true })
    const previousUnmount = process.env.JAVDEX_TEST_UMOUNT_SCAN
    const { base, config } = await boot(dataDir, { m08: mountPoint })
    const writer = await claimInitialWriter(base, config)
    const pageCount = SCAN_CLEANUP_PAGE_SIZE + 1
    const codeAt = (index: number) => `PG-${String(index + 1).padStart(3, '0')}`

    const versions = (library: { revision: number; config: { revision: number } }) => ({
      L: { generation: 1, revision: library.revision },
      C: { generation: 1, revision: library.config.revision },
      G: { generation: 1, revision: 1 },
      V: { generation: 1, revision: 1 },
      R: { generation: 1, revision: 1 }
    })
    const write = async (operation: string, expectedVersions: unknown, input: unknown) =>
      postManage(
        base,
        operation,
        {
          operationId: randomUUID(),
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          expectedVersions,
          input
        },
        { bearer: writer.secret }
      )
    const read = async (operation: string, input: unknown) =>
      postManage(
        base,
        operation,
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          input
        },
        { bearer: writer.secret }
      )
    const pollTask = async (taskId: string, timeoutMs = 60_000) => {
      const startedAt = Date.now()
      let last: { state: string; counts?: { removed?: number } } | undefined
      while (Date.now() - startedAt < timeoutMs) {
        const result = await read('tasks.get', { taskId })
        assert.equal(result.status, 200)
        last = result.json as { state: string; counts?: { removed?: number } }
        if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
    }
    const pageResourceCount = () =>
      (
        getDb()
          .prepare(
            `SELECT COUNT(*) AS n
               FROM video_resources resource
               JOIN videos video ON video.id = resource.video_id
              WHERE resource.library_id = 1 AND video.code LIKE 'PG-%'`
          )
          .get() as { n: number }
      ).n

    let library = (await read('libraries.get', { libraryId: 1 })).json as {
      revision: number
      config: { revision: number }
      roots: Array<{ id: number; path: string }>
    }
    try {
      const configUpdated = await write('libraries.updateConfig', versions(library), {
        libraryId: 1,
        patch: { minImportDurationMinutes: 0 }
      })
      assert.equal(configUpdated.status, 200)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const added = await write('libraries.addRoot', versions(library), {
        libraryId: 1,
        root: { mountSelectionId: 'm08' }
      })
      assert.equal(added.status, 200, JSON.stringify(added.json))
      const addedRoot = added.json as { id: number; path: string }
      for (let index = 0; index < pageCount; index += 1) {
        fs.writeFileSync(path.join(mountPoint, `${codeAt(index)}.mp4`), Buffer.from('0123456789abcdef'))
      }
      const markerStat = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))

      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const imported = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(imported.status, 200, JSON.stringify(imported.json))
      const importedTask = await pollTask((imported.json as { taskId: string }).taskId)
      assert.equal(importedTask.state, 'succeeded', JSON.stringify(importedTask))
      assert.equal(pageResourceCount(), pageCount)

      for (let index = 0; index < pageCount; index += 1) {
        fs.unlinkSync(path.join(backing, `${codeAt(index)}.mp4`))
      }
      const instructionPath = path.join(instructionDir, 'between-pages.json')
      fs.writeFileSync(
        instructionPath,
        JSON.stringify({ phase: 'beforeCleanupPage', kind: 'resources', afterPages: 1 })
      )
      process.env.JAVDEX_TEST_UMOUNT_SCAN = instructionPath
      const watch = watchTestUnmount(instructionPath, mountPoint)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const partial = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(partial.status, 200, JSON.stringify(partial.json))
      const partialTask = await pollTask((partial.json as { taskId: string }).taskId)
      assert.equal(partialTask.state, 'succeeded', JSON.stringify(partialTask))
      await watch
      assert.equal(pageResourceCount(), 1, 'the committed first cleanup page must stay; the next page must not delete')
      assert.equal(isBindMounted(mountPoint), false)
      assert.equal(fs.existsSync(mountPoint), true)
      const latest = (await read('scans.getLatest', { libraryId: 1 })).json as {
        summary?: { offlineFolders?: string[]; removed?: number }
        offlineFolders?: string[]
        removed?: number
      }
      const offline = latest.summary?.offlineFolders ?? latest.offlineFolders ?? []
      assert.equal(
        offline.some((folder) => folder === addedRoot.path || folder === mountPoint),
        true,
        JSON.stringify(latest)
      )
      const removed = latest.summary?.removed ?? latest.removed
      if (typeof removed === 'number') assert.equal(removed, SCAN_CLEANUP_PAGE_SIZE, JSON.stringify(latest))

      bindMount(backing, mountPoint)
      const remountedMarker = fs.statSync(path.join(backing, JAVDEX_ROOT_MARKER))
      assert.equal(remountedMarker.ino, markerStat.ino)
      library = (await read('libraries.get', { libraryId: 1 })).json as typeof library
      const finished = await write('scans.run', versions(library), { libraryId: 1 })
      assert.equal(finished.status, 200, JSON.stringify(finished.json))
      const finishedTask = await pollTask((finished.json as { taskId: string }).taskId)
      assert.equal(finishedTask.state, 'succeeded', JSON.stringify(finishedTask))
      assert.equal(pageResourceCount(), 0)
      assert.equal(fs.existsSync(path.join(mountPoint, JAVDEX_ROOT_MARKER)), true)
    } finally {
      if (previousUnmount === undefined) delete process.env.JAVDEX_TEST_UMOUNT_SCAN
      else process.env.JAVDEX_TEST_UMOUNT_SCAN = previousUnmount
      try {
        unmountBind(mountPoint)
      } catch {
        // Keep the suite able to delete the temp tree even if umount already ran.
      }
    }
  })

  it('rejects an expired or restarted NFO plan and keeps manage available after browser disable', async () => {
    const mount = path.join(root, 'm09-media')
    fs.mkdirSync(mount, { recursive: true })
    fs.writeFileSync(path.join(mount, 'M09-001.mp4'), Buffer.from('0123456789abcdef'))
    const dataDir = path.join(root, 'm09-plan-expire')
    const extraMounts = { m09: mount }
    const nfoInput = {
      libraryIds: [1],
      profileId: 'portable-v1',
      includeCover: true,
      includeFanart: false,
      includeSamples: false,
      includeActorAvatars: false,
      collisionPolicy: 'replace'
    }
    const versions = (library: { revision: number; config: { revision: number } }) => ({
      L: { generation: 1, revision: library.revision },
      C: { generation: 1, revision: library.config.revision },
      G: { generation: 1, revision: 1 },
      V: { generation: 1, revision: 1 },
      R: { generation: 1, revision: 1 }
    })
    const session = async (base: string, writer: { serverId: string; catalogId: string; writerEpoch: number; secret: string }) => {
      const write = async (operation: string, expectedVersions: unknown, input: unknown) =>
        postManage(
          base,
          operation,
          {
            operationId: randomUUID(),
            serverId: writer.serverId,
            catalogId: writer.catalogId,
            writerEpoch: writer.writerEpoch,
            expectedVersions,
            input
          },
          { bearer: writer.secret }
        )
      const read = async (operation: string, input: unknown) =>
        postManage(
          base,
          operation,
          {
            serverId: writer.serverId,
            catalogId: writer.catalogId,
            writerEpoch: writer.writerEpoch,
            input
          },
          { bearer: writer.secret }
        )
      const pollTask = async (taskId: string, timeoutMs = 60_000) => {
        const startedAt = Date.now()
        let last: { state: string } | undefined
        while (Date.now() - startedAt < timeoutMs) {
          const result = await read('tasks.get', { taskId })
          assert.equal(result.status, 200)
          last = result.json as { state: string }
          if (['succeeded', 'failed', 'cancelled', 'needsInspection'].includes(last.state)) return last
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        throw new Error(`task ${taskId} did not finish: ${last?.state ?? 'missing'}`)
      }
      return { write, read, pollTask }
    }

    const first = await boot(dataDir, extraMounts)
    const writer = await claimInitialWriter(first.base, first.config)
    let helpers = await session(first.base, writer)
    let library = (await helpers.read('libraries.get', { libraryId: 1 })).json as {
      revision: number
      config: { revision: number }
    }
    const configUpdated = await helpers.write('libraries.updateConfig', versions(library), {
      libraryId: 1,
      patch: { minImportDurationMinutes: 0 }
    })
    assert.equal(configUpdated.status, 200, JSON.stringify(configUpdated.json))
    library = (await helpers.read('libraries.get', { libraryId: 1 })).json as typeof library
    const added = await helpers.write('libraries.addRoot', versions(library), {
      libraryId: 1,
      root: { mountSelectionId: 'm09' }
    })
    assert.equal(added.status, 200, JSON.stringify(added.json))
    library = (await helpers.read('libraries.get', { libraryId: 1 })).json as typeof library
    const imported = await helpers.write('scans.run', versions(library), { libraryId: 1 })
    assert.equal(imported.status, 200, JSON.stringify(imported.json))
    const importedTask = await helpers.pollTask((imported.json as { taskId: string }).taskId)
    assert.equal(importedTask.state, 'succeeded', JSON.stringify(importedTask))
    library = (await helpers.read('libraries.get', { libraryId: 1 })).json as typeof library
    const expiredPlan = await helpers.write('nfo.plan', versions(library), nfoInput)
    assert.equal(expiredPlan.status, 200, JSON.stringify(expiredPlan.json))
    const expired = expiredPlan.json as { planId: string; planDigest: string }
    getDb()
      .prepare("UPDATE catalog_maintenance_plans SET expires_at = '2000-01-01T00:00:00.000Z' WHERE plan_id = ?")
      .run(expired.planId)
    const expiredStart = await helpers.write('nfo.start', versions(library), {
      planId: expired.planId,
      planDigest: expired.planDigest
    })
    assert.equal(expiredStart.status, 409, JSON.stringify(expiredStart.json))
    assert.equal((expiredStart.json as { code?: string }).code, 'VERSION_CONFLICT')
    const restartPlan = await helpers.write('nfo.plan', versions(library), nfoInput)
    assert.equal(restartPlan.status, 200, JSON.stringify(restartPlan.json))
    const beforeRestart = restartPlan.json as { planId: string; planDigest: string }
    assert.equal(fs.existsSync(path.join(mount, 'M09-001.nfo')), false)
    await server!.stop()
    server = undefined
    resetLibraryHostForTests()
    const second = await boot(dataDir, extraMounts)
    helpers = await session(second.base, writer)
    library = (await helpers.read('libraries.get', { libraryId: 1 })).json as typeof library
    const restartedStart = await helpers.write('nfo.start', versions(library), {
      planId: beforeRestart.planId,
      planDigest: beforeRestart.planDigest
    })
    assert.equal(restartedStart.status, 409, JSON.stringify(restartedStart.json))
    assert.equal((restartedStart.json as { code?: string }).code, 'VERSION_CONFLICT')
    const livePlan = await helpers.write('nfo.plan', versions(library), nfoInput)
    assert.equal(livePlan.status, 200, JSON.stringify(livePlan.json))
    const live = livePlan.json as { planId: string; planDigest: string }
    const started = await helpers.write('nfo.start', versions(library), {
      planId: live.planId,
      planDigest: live.planDigest
    })
    assert.equal(started.status, 200, JSON.stringify(started.json))
    const nfoTask = await helpers.pollTask((started.json as { taskId: string }).taskId)
    assert.equal(['succeeded', 'needsInspection'].includes(nfoTask.state), true, JSON.stringify(nfoTask))
    assert.equal(fs.existsSync(path.join(mount, 'M09-001.nfo')), true)
    const disabled = await helpers.write('browser.setEnabled', {}, { enabled: false })
    assert.equal(disabled.status, 200, JSON.stringify(disabled.json))
    const helloOff = await postManage(second.base, 'handshake.get', { input: {} }, { appVersion: '' })
    assert.equal(helloOff.status, 200)
    assert.equal(
      (helloOff.json as { capabilities?: { browserEnabled?: boolean } }).capabilities?.browserEnabled,
      false
    )
    const loginOff = await login(second.base, password, true)
    assert.equal(loginOff.status, 404)
    const manageWhileOff = await helpers.read('videos.list', {
      scope: { kind: 'library', libraryId: 1 },
      query: { limit: 10, offset: 0 }
    })
    assert.equal(manageWhileOff.status, 200, JSON.stringify(manageWhileOff.json))
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
    const drafts = new AgentMetadataDraftRepo(getDb)
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

    const extraLibrary = await postManage(
      base,
      'libraries.create',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: { name: 'S10 Extra' }
      },
      { bearer: writer.secret }
    )
    assert.equal(extraLibrary.status, 200, JSON.stringify(extraLibrary.json))
    const extraLibraryId = (extraLibrary.json as { id: number }).id
    const memberPreview = await postManage(
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
    assert.equal(memberPreview.status, 200, JSON.stringify(memberPreview.json))
    const memberImpact = memberPreview.json as { revision: string; libraryIds?: number[] }
    assert.equal(
      ensureVideoMembership({ libraryId: extraLibraryId, videoId: second.videoId, addedVia: 'shared' }),
      true
    )
    const memberStale = await postManage(
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
          planDigest: memberImpact.revision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(memberStale.status, 409, JSON.stringify(memberStale.json))
    assert.equal((memberStale.json as { code?: string }).code, 'VERSION_CONFLICT')
    assert.equal(
      (getDb().prepare('SELECT id FROM videos WHERE id = ?').get(second.videoId) as { id: number } | undefined)?.id,
      second.videoId
    )
    assert.equal(
      (
        getDb()
          .prepare(
            'SELECT 1 AS ok FROM library_video_memberships WHERE library_id = ? AND video_id = ?'
          )
          .get(extraLibraryId, second.videoId) as { ok: number } | undefined
      )?.ok,
      1
    )

    const resourcePreview = await postManage(
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
    assert.equal(resourcePreview.status, 200, JSON.stringify(resourcePreview.json))
    const resourceImpact = resourcePreview.json as { revision: string }
    const membershipsBefore = (
      getDb()
        .prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE video_id = ?')
        .get(second.videoId) as { n: number }
    ).n
    const resourceVersion = getDb()
      .prepare('SELECT generation, revision FROM videos WHERE id = ?')
      .get(second.videoId) as { generation: number; revision: number }
    const linked = await postManage(
      base,
      'videos.importResource',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: { V: resourceVersion },
        input: {
          libraryId: 1,
          code: 'S10-002',
          target: { kind: 'existing', videoId: second.videoId },
          url: 'https://example.test/s10-resource-only',
          kind: 'web',
          displayName: 'S10 resource only'
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(linked.status, 200, JSON.stringify(linked.json))
    assert.equal(
      (
        getDb()
          .prepare('SELECT COUNT(*) AS n FROM library_video_memberships WHERE video_id = ?')
          .get(second.videoId) as { n: number }
      ).n,
      membershipsBefore
    )
    const resourceStale = await postManage(
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
          planDigest: resourceImpact.revision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(resourceStale.status, 409, JSON.stringify(resourceStale.json))
    assert.equal((resourceStale.json as { code?: string }).code, 'VERSION_CONFLICT')
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
    const frozenVictim = ids.find((id) => id !== firstIds[0])
    assert.ok(frozenVictim)
    const deletePreview = await postManage(
      base,
      'videos.previewDeleteGlobal',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        input: { videoId: frozenVictim }
      },
      { bearer: writer.secret }
    )
    assert.equal(deletePreview.status, 200, JSON.stringify(deletePreview.json))
    const deleted = await postManage(
      base,
      'videos.deleteGlobal',
      {
        operationId: randomUUID(),
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        writerEpoch: writer.writerEpoch,
        expectedVersions: {},
        input: {
          videoId: frozenVictim,
          planId: randomUUID(),
          planDigest: (deletePreview.json as { revision: string }).revision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json))
    assert.equal(
      getDb().prepare('SELECT id FROM videos WHERE id = ?').get(frozenVictim) as { id: number } | undefined,
      undefined
    )
    const afterDeletePage = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId, limit: 1, offset: 1 }
      },
      { bearer: writer.secret }
    )
    assert.equal(afterDeletePage.status, 200, JSON.stringify(afterDeletePage.json))
    assert.deepEqual((afterDeletePage.json as { ids: number[] }).ids, [ids[1]])
    const afterDeleteFull = await postManage(
      base,
      'targetLists.page',
      {
        serverId: writer.serverId,
        catalogId: writer.catalogId,
        input: { targetListId }
      },
      { bearer: writer.secret }
    )
    assert.equal(afterDeleteFull.status, 200, JSON.stringify(afterDeleteFull.json))
    assert.deepEqual((afterDeleteFull.json as { ids: number[] }).ids, ids)
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

  it('round-trips playlist detail and filtered pages through the same contracts as local reads', async () => {
    const { base, config } = await boot(path.join(root, 'playlist-detail-contract'))
    const writer = await claimInitialWriter(base, config)
    const db = getDb()
    db.exec(`
      INSERT INTO videos(id,code,title,release_date) VALUES(991,'PL-991',NULL,'2020-01-02'),(992,'PL-992','Second','2024-02-03');
      INSERT INTO playlists(id,name,created_at) VALUES(991,'Contract playlist','2026-09-20T00:00:00.000Z');
      INSERT INTO playlist_video(playlist_id,video_id,position,added_at) VALUES(991,991,0,'2026-01-01'),(991,992,1,'2026-01-02');
    `)
    const remote = createRemoteCatalogBackend({ baseUrl: base, appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]])) })
    const local = createLocalCatalogBackend({ identity: { mode: 'local', catalogId: writer.catalogId } })
    try {
      for (const sortDir of ['asc', 'desc'] as const) {
        for (const operation of ['get', 'metadata'] as const) {
          const query = { playlistId: 991, sortBy: 'release_date' as const, sortDir }
          assert.deepEqual(await remote.playlists[operation](query), await local.playlists[operation](query))
        }
        for (const operation of ['getPage', 'videoPage'] as const) {
          for (const offset of [0, 1, 2]) {
            const query = { playlistId: 991, sortBy: 'release_date' as const, sortDir,
              resourceKinds: ['none' as const], limit: 1, offset }
            const page = await remote.playlists[operation](query)
            assert.deepEqual(page, await local.playlists[operation](query))
            assert.equal(page?.total, 2)
            assert.equal(page?.filteredTotal, 2)
            assert.equal(page?.videos.length, offset < 2 ? 1 : 0)
          }
        }
      }
      const query = { search: 'Contract', videoId: 991, limit: 1, offset: 0 }
      assert.deepEqual(await remote.playlists.listPage(query), await local.playlists.listPage(query))
      assert.equal(await remote.playlists.get({ playlistId: 999999 }), null)
      const library = await remote.libraries.get({ libraryId: 1 })
      assert.ok(library)
      const input = { name: 'Imported contract playlist', libraryId: 1, videoIds: [991, 992],
        sourceUrl: 'https://example.test/list', videoLinks: [{ videoId: 991, label: 'Detail', url: 'https://example.test/991' }] }
      const context = { operationId: randomUUID(), expectedVersions: {
        L: { generation: 1, revision: library.revision }, V: { generation: 1, revision: 1 }
      } }
      await assert.rejects(async () => remote.playlists.applyImport({ ...input, videoIds: [991, 992, 991] }, context),
        (error: unknown) => isStructuredError(error) && error.code === 'INVALID_INPUT')
      const applied = await remote.playlists.applyImport(input, context)
      assert.equal(applied.added, 2)
      assert.equal(applied.relatedLinksAdded, 1)
      assert.deepEqual(await remote.playlists.applyImport(input, context), applied)
      assert.equal((await remote.playlists.get({ playlistId: applied.playlistId }))?.videos.length, 2)
      await assert.rejects(remote.playlists.applyImport(input, {
        operationId: randomUUID(), expectedVersions: { ...context.expectedVersions,
          L: { generation: 1, revision: library.revision - 1 } }
      }), (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')

    } finally {
      await remote.dispose()
      await local.dispose()
    }
  })

  it('edits an actress with an uploaded avatar through the shared use case and validates its detail DTO', async () => {
    const { base, config } = await boot(path.join(root, 'actress-edit-contract'))
    const writer = await claimInitialWriter(base, config)
    const actressId = upsertActressFromScrape('Contract actor', null, 'female')
    const original = getDb().prepare('SELECT generation, revision FROM actresses WHERE id = ?')
      .get(actressId) as { generation: number; revision: number }
    const uploaded = await postManage(base, 'uploads.create', {
      operationId: randomUUID(), serverId: writer.serverId, catalogId: writer.catalogId,
      writerEpoch: writer.writerEpoch, expectedVersions: {},
      input: { purpose: 'actressAvatar', contentType: 'image/png' }
    }, { bearer: writer.secret })
    assert.equal(uploaded.status, 200)
    const uploadId = (uploaded.json as { uploadId: string }).uploadId
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer()
    assert.equal((await putUpload(base, uploadId, png, { bearer: writer.secret })).status, 200)
    const remote = createRemoteCatalogBackend({
      baseUrl: base, appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    })
    const local = createLocalCatalogBackend({ identity: { mode: 'local', catalogId: writer.catalogId } })
    try {
      const input = { actressId, fields: { main_name: 'Contract renamed', birth_date: '1990-01-02',
        profile_summary: null, avatar: { kind: 'upload' as const, uploadId } } }
      const context = { operationId: randomUUID(), expectedVersions: { A: original } }
      assert.equal(await remote.actresses.edit(input, context), true)
      assert.equal(await remote.actresses.edit(input, context), true)
      const detail = await remote.actresses.get({ actressId })
      assert.ok(detail)
      assert.equal(detail.revision, original.revision + 1)
      assert.equal(detail.birth_date, '1990-01-02')
      assert.equal(detail.profile_summary, null)
      assert.ok(detail.avatar_path)
      assert.deepEqual(detail, await local.actresses.get({ actressId }))
      assert.deepEqual(await remote.actresses.profile({ actressId }), await local.actresses.profile({ actressId }))
      assert.deepEqual(await remote.actresses.metadata({ actressId }), await local.actresses.metadata({ actressId }))
      await assert.rejects(remote.actresses.edit({ actressId, fields: { main_name: 'Stale' } }, {
        ...context, operationId: randomUUID()
      }), (error: unknown) => isStructuredError(error) && error.code === 'VERSION_CONFLICT')
      assert.equal(await remote.actresses.edit({ actressId, fields: { avatar: { kind: 'clear' } } }, {
        operationId: randomUUID(), expectedVersions: { A: { generation: detail.generation!, revision: detail.revision! } }
      }), true)
      const cleared = await remote.actresses.get({ actressId })
      assert.equal(cleared?.avatar_path, null)
      assert.equal(cleared?.revision, original.revision + 2)
    } finally {
      await remote.dispose()
      await local.dispose()
    }
  })

  it('validates real detail JSON through RemoteCatalogBackend and matches the local projection', async () => {
    const { base, config } = await boot(path.join(root, 'detail-contract'))
    const writer = await claimInitialWriter(base, config)
    const clip = path.join(mediaRoot, 'DTO-001.mp4')
    fs.writeFileSync(clip, 'video')
    const { videoId } = await insertBoundVideo('DTO-001', clip)
    getDb().prepare('UPDATE video_resources SET duration_seconds = 123 WHERE video_id = ?').run(videoId)
    const credentials = memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    const remote = createRemoteCatalogBackend({ baseUrl: base, appVersion: SERVER_APP_VERSION, credentials })
    const local = createLocalCatalogBackend({ identity: { mode: 'local', catalogId: writer.catalogId } })
    const input = { scope: { kind: 'library' as const, libraryId: 1 }, videoId }
    // Corrupt actual server JSON, not a hand-written valid fixture. This also
    // catches additions to the server DTO that its consumers fail to describe.
    let corrupt: (body: Record<string, unknown>) => void = () => {}
    const proxy = createHttpServer(async (request, response) => {
      try {
        let body = ''
        for await (const chunk of request) body += chunk
        const upstream = await fetch(`${base}${request.url}`, {
          method: 'POST', body,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': request.headers.authorization ?? '',
            'X-Javdex-App-Version': SERVER_APP_VERSION
          }
        })
        const json = await upstream.json() as Record<string, unknown>
        if (request.url?.endsWith('/videos.get')) corrupt(json)
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(json))
      } catch {
        response.writeHead(502).end()
      }
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    const address = proxy.address()
    assert.ok(address && typeof address !== 'string')
    const throughProxy = createRemoteCatalogBackend({
      baseUrl: `http://127.0.0.1:${address.port}`, appVersion: SERVER_APP_VERSION, credentials
    })
    try {
      const localDetail = await local.queries.getVideo(input)
      const remoteDetail = await remote.queries.getVideo(input)
      assert.ok(localDetail && remoteDetail)
      assert.equal(remoteDetail.resolved_duration_seconds, 123)
      assert.deepEqual(remoteDetail, {
        ...localDetail,
        resources: localDetail.resources.map(resource => ({
          ...resource, display_locator: path.basename(resource.display_locator)
        }))
      })
      assert.deepEqual(await throughProxy.queries.getVideo(input), remoteDetail)
      for (const [field, mutation] of [
        ['title', (json: Record<string, unknown>) => { delete json.title }],
        ['rating', (json: Record<string, unknown>) => { json.rating = 'private-invalid-value' }],
        ['resources.0.display_locator', (json: Record<string, unknown>) => {
          delete (json.resources as Array<Record<string, unknown>>)[0].display_locator
        }],
        ['resources.0', (json: Record<string, unknown>) => {
          (json.resources as Array<Record<string, unknown>>)[0].locator = '/private/raw/path'
        }]
      ] as const) {
        corrupt = mutation
        await assert.rejects(throughProxy.queries.getVideo(input), (error: unknown) => {
          assert.ok(isStructuredError(error))
          assert.equal(error.code, 'INVALID_INPUT')
          assert.equal(error.details?.field, field)
          assert.equal(error.message.includes('private'), false)
          return true
        })
      }
      assert.equal(await remote.queries.getVideo({ ...input, videoId: 999999 }), null)
    } finally {
      await remote.dispose()
      await local.dispose()
      await throughProxy.dispose()
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    }
  })

  it('grants a 12-hour play token, streams Range, and serves manage images without cookies', async () => {
    const dataDir = path.join(root, 's11-play')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const clip = path.join(mediaRoot, 'S11-001.mp4')
    fs.writeFileSync(clip, Buffer.from('0123456789abcdef'))
    const { videoId, fileId } = await insertBoundVideo('S11-001', clip)
    const detailResponse = await postManage(base, 'videos.get', {
      serverId: writer.serverId, catalogId: writer.catalogId,
      input: { scope: { kind: 'library', libraryId: 1 }, videoId }
    }, { bearer: writer.secret })
    assert.equal(detailResponse.status, 200)
    const detailResource = (detailResponse.json as { resources: Array<Record<string, unknown>> }).resources[0]
    assert.equal(detailResource.display_locator, 'S11-001.mp4')
    assert.equal('locator' in detailResource, false)
    assert.equal('resource_key' in detailResource, false)
    assert.equal('source_identity' in detailResource, false)

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

  it('plays real mpv Range grants through disconnect, expiry, and writer handoff', { timeout: 120_000 }, async () => {
    assert.equal(fs.existsSync('/usr/bin/mpv'), true)
    const dataDir = path.join(root, 's13-m15-mpv')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const mp4 = path.join(mediaRoot, 'S15-001.mp4')
    const mkv = path.join(mediaRoot, 'S15-002.mkv')
    encodeTestMedia(mp4)
    encodeTestMedia(mkv)
    const first = await insertBoundVideo('S15-001', mp4)
    const second = await insertBoundVideo('S15-002', mkv)
    const resource = getDb()
      .prepare('SELECT * FROM video_resources WHERE id = ?')
      .get(first.fileId) as {
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
          videoId: first.videoId,
          resourceId: first.fileId,
          locatorRevision
        }
      },
      { bearer: writer.secret }
    )
    assert.equal(granted.status, 200, JSON.stringify(granted.json))
    const play = granted.json as { grantId: string; playbackHandle: string }
    const socketPath = path.join(dataDir, 'mpv.sock')
    const mpv = await startMpv(socketPath)
    try {
      const loaded = await mpvRpc(socketPath, ['loadfile', play.playbackHandle, 'replace'])
      assert.equal(loaded.error, 'success', JSON.stringify(loaded))
      const started = await waitMpvTimePos(socketPath, (value) => value >= 0.2)
      assert.ok(started >= 0.2, String(started))
      closePlayStreams([play.grantId])
      await new Promise((resolve) => setTimeout(resolve, 200))
      const reloaded = await mpvRpc(socketPath, ['loadfile', play.playbackHandle, 'replace'])
      assert.equal(reloaded.error, 'success', JSON.stringify(reloaded))
      const resumed = await waitMpvTimePos(socketPath, (value) => value >= 0.2)
      assert.ok(resumed >= 0.2, String(resumed))
      const stored = readCatalogSetting<StoredPlayGrant | null>(`play-grant:${play.grantId}`, null)
      assert.ok(stored)
      writeCatalogSetting(`play-grant:${play.grantId}`, {
        ...stored,
        expiresAt: new Date(Date.now() - 1_000).toISOString()
      })
      await mpvRpc(socketPath, ['stop'])
      await mpvRpc(socketPath, ['loadfile', play.playbackHandle, 'replace'])
      await new Promise((resolve) => setTimeout(resolve, 800))
      const expiredHead = await fetch(play.playbackHandle, { method: 'HEAD' })
      assert.equal(expiredHead.status, 404)
      assert.match(mpv.log(), /404|HTTP error/i)

      const mkvResource = getDb()
        .prepare('SELECT * FROM video_resources WHERE id = ?')
        .get(second.fileId) as {
          kind: 'local'
          locator: string
          source_identity: string | null
          root_id: number | null
          size_bytes: number | null
          file_mtime_ms: number | null
        }
      const nextGranted = await postManage(
        base,
        'play.grant',
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          input: {
            libraryId: 1,
            videoId: first.videoId,
            resourceId: first.fileId,
            locatorRevision
          }
        },
        { bearer: writer.secret }
      )
      assert.equal(nextGranted.status, 200, JSON.stringify(nextGranted.json))
      const nextPlay = nextGranted.json as { grantId: string; playbackHandle: string }
      const seekLoad = await mpvRpc(socketPath, ['loadfile', nextPlay.playbackHandle, 'replace'])
      assert.equal(seekLoad.error, 'success', JSON.stringify(seekLoad))
      await waitMpvTimePos(socketPath, (value) => value >= 0.15)
      const seeked = await mpvRpc(socketPath, ['seek', 2.2, 'absolute'])
      assert.equal(seeked.error, 'success', JSON.stringify(seeked))
      const seekPos = await waitMpvTimePos(socketPath, (value) => value >= 2.05 && value < 3.4)
      assert.ok(seekPos >= 2.05, String(seekPos))

      const mkvGrant = await postManage(
        base,
        'play.grant',
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          input: {
            libraryId: 1,
            videoId: second.videoId,
            resourceId: second.fileId,
            locatorRevision: resourceLocatorRevision(mkvResource)
          }
        },
        { bearer: writer.secret }
      )
      assert.equal(mkvGrant.status, 200, JSON.stringify(mkvGrant.json))
      const mkvPlay = mkvGrant.json as { playbackHandle: string }
      const mkvLoad = await mpvRpc(socketPath, ['loadfile', mkvPlay.playbackHandle, 'replace'])
      assert.equal(mkvLoad.error, 'success', JSON.stringify(mkvLoad))
      const mkvPos = await waitMpvTimePos(socketPath, (value) => value >= 0.2)
      assert.ok(mkvPos >= 0.2, String(mkvPos))
      const seekDuring = await mpvRpc(socketPath, ['seek', 2.2, 'absolute'])
      assert.equal(seekDuring.error, 'success', JSON.stringify(seekDuring))
      await waitMpvTimePos(socketPath, (value) => value >= 2.05 && value < 3.4)

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
      await mpvRpc(socketPath, ['seek', 3.1, 'absolute'])
      await new Promise((resolve) => setTimeout(resolve, 400))
      const revoked = await fetch(mkvPlay.playbackHandle, { method: 'HEAD' })
      assert.equal(revoked.status, 404)
      assert.match(mpv.log(), /404|HTTP error/i)
    } finally {
      mpv.child.kill('SIGKILL')
    }
  })

  it('plays a real mpv Range grant through a non-loopback listen address', { timeout: 60_000 }, async () => {
    assert.equal(fs.existsSync('/usr/bin/mpv'), true)
    const lan = addNonLoopbackListenHost()
    assert.notEqual(lan.host, '127.0.0.1')
    assert.equal(lan.host.startsWith('127.'), false)
    const dataDir = path.join(root, 's13-m15-lan')
    try {
      const { base, config } = await boot(dataDir, {}, { listenHost: lan.host, accessHosts: [lan.host] })
      assert.equal(config.listenHost, lan.host)
      assert.match(base, new RegExp(`^http://${lan.host.replaceAll('.', '\\.')}:\\d+$`))
      const writer = await claimInitialWriter(base, config)
      const mp4 = path.join(mediaRoot, 'S15-LAN.mp4')
      encodeTestMedia(mp4)
      const bound = await insertBoundVideo('S15-LAN', mp4)
      const resource = getDb()
        .prepare('SELECT * FROM video_resources WHERE id = ?')
        .get(bound.fileId) as {
          kind: 'local'
          locator: string
          source_identity: string | null
          root_id: number | null
          size_bytes: number | null
          file_mtime_ms: number | null
        }
      const granted = await postManage(
        base,
        'play.grant',
        {
          serverId: writer.serverId,
          catalogId: writer.catalogId,
          writerEpoch: writer.writerEpoch,
          input: {
            libraryId: 1,
            videoId: bound.videoId,
            resourceId: bound.fileId,
            locatorRevision: resourceLocatorRevision(resource)
          }
        },
        { bearer: writer.secret }
      )
      assert.equal(granted.status, 200, JSON.stringify(granted.json))
      const play = granted.json as { grantId: string; playbackHandle: string }
      assert.match(
        play.playbackHandle,
        new RegExp(`^http://${lan.host.replaceAll('.', '\\.')}:\\d+/play/v1/`)
      )
      const head = await fetch(play.playbackHandle, { method: 'HEAD' })
      assert.equal(head.status, 200, await head.text())
      const socketPath = path.join(dataDir, 'mpv-lan.sock')
      const mpv = await startMpv(socketPath)
      try {
        const loaded = await mpvRpc(socketPath, ['loadfile', play.playbackHandle, 'replace'])
        assert.equal(loaded.error, 'success', JSON.stringify(loaded))
        const started = await waitMpvTimePos(socketPath, (value) => value >= 0.2)
        assert.ok(started >= 0.2, String(started))
      } finally {
        mpv.child.kill('SIGKILL')
      }
    } finally {
      await server?.stop()
      server = undefined
      closeDatabase()
      resetLibraryHostForTests()
      lan.cleanup()
    }
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
        phase: string
      }
      assert.equal(status.phase, 'frozen')
    } finally {
      await remote.dispose()
    }
  })

  it('fails an in-flight remote query with a TCP RST and reconnects on a new generation', async () => {
    const dataDir = path.join(root, 'd04-tcp-rst')
    const { base, config } = await boot(dataDir)
    const writer = await claimInitialWriter(base, config)
    const { videoId } = await insertBoundVideo('D04-RST')
    const proxy = await startTcpRstProxy(Number(new URL(base).port))
    const remote = createRemoteCatalogBackend({
      baseUrl: `http://127.0.0.1:${proxy.port}`,
      appVersion: SERVER_APP_VERSION,
      credentials: memoryCredentials(new Map([[writer.catalogId, writer.secret]]))
    })
    try {
      const warmup = (await remote.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string }
      assert.equal(warmup.title, 'D04-RST')
      const generationBefore = remote.generation
      proxy.dropUpstreamToClient()
      const pending = remote.queries.getVideo({ scope: { kind: 'all' }, videoId })
      const pendingError = pending.then(
        () => {
          throw new Error('RST query resolved')
        },
        (error: unknown) => error
      )
      const started = Date.now()
      while (proxy.droppedBytes() < 1 && Date.now() - started < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(proxy.droppedBytes() > 0, 'proxy must see the live videos.get response before RST')
      proxy.resetAll()
      const reset = await pendingError
      assert.equal(isStructuredError(reset), true, JSON.stringify(reset))
      assert.equal((reset as { code?: string }).code, 'CONNECTION_UNAVAILABLE')
      assert.equal((reset as { message?: string }).message, '无法连接远程资料库')
      proxy.forwardUpstreamToClient()
      const next = await remote.reconnect()
      assert.ok(next.generation > generationBefore, `${generationBefore} -> ${next.generation}`)
      const fresh = (await remote.queries.getVideo({
        scope: { kind: 'all' },
        videoId
      })) as { title: string }
      assert.equal(fresh.title, 'D04-RST')
      assert.equal(remote.session().state, 'available')
      assert.equal(
        (getDb().prepare('SELECT title FROM videos WHERE id = ?').get(videoId) as { title: string }).title,
        'D04-RST'
      )
    } finally {
      await remote.dispose()
      await proxy.close()
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
        void hold.then(() => {
          try {
            if (response.writableEnded) return
            send(null)
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
      }))
      assert.equal(fresh, null)
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
