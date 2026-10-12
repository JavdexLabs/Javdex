import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { channel } from 'node:diagnostics_channel'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { WebServer } from '@http/server'
import { WebCatalog } from '@http/catalog'
import { hashPassword, WebSessions } from '@http/auth'
import { closePlayStreams } from '@http/play'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { insertTestVideoWithFile } from '@library/db/testVideoFixtures'
import { resolveMediaLibraryRootIdentity } from '@library/mediaLibraryRootPath'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { issueOneTimeToken } from '@library/catalog/catalogWriter'
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import { inspectPlayStream, setPlayGrantListener, revokeAllPlayGrants } from '@library/catalog/catalogPlay'
import { configureLibraryHost, resetLibraryHostForTests } from '@library/runtime/host'
import { dispatchManageOperation } from '../../../../../server/src/manageDispatch'
import { SERVER_APP_VERSION } from '../../../../../server/src/appVersion'
import type { PlayGrant } from '@shared/protocol/play'
import type { RemotePlaybackFixtureStats, RemotePlaybackSource } from './remoteFixture'

const port = parentPort!
const { directory, files } = workerData as { directory: string; files: string[] }
let server: WebServer | undefined
let stopped = false
const counters = {
  requests: 0, playRequests: 0, rangeRequests: 0, partialResponses: 0,
  bytes: 0, mediaBytes: 0, rangeBytes: 0, rejected401: 0, rejected404: 0,
  abortedResponses: 0, activeRequests: 0
}
let startup: RemotePlaybackFixtureStats['startup'] = { requests: 0, playRequests: 0, rangeRequests: 0, mediaBytes: 0, rangeBytes: 0 }
const checks: RemotePlaybackFixtureStats['checks'] = {
  missingBearer: 0, wrongBearer: 0, missingPlayToken: 0, wrongPlayToken: 0,
  head: 0, range: 0, bytesMatch: false
}
const snapshot = (): RemotePlaybackFixtureStats => ({ ...counters, startup: { ...startup }, checks: { ...checks } })

// Observe the real HTTP server without exposing private WebServer fields or adding
// an HTTP proxy. The worker owns exactly one HTTP server, never a desktop server.
const requests = channel('http.server.request.start')
const observe = (message: unknown): void => {
  const { request, response } = message as { request: IncomingMessage; response: ServerResponse }
  const play = request.url?.startsWith('/play/v1/') === true
  counters.requests++
  counters.activeRequests++
  if (play) counters.playRequests++
  if (request.headers.range) counters.rangeRequests++
  const count = (args: unknown[]): void => {
    const body = args[0]
    const size = typeof body === 'string'
      ? Buffer.byteLength(body, typeof args[1] === 'string' ? args[1] as BufferEncoding : 'utf8')
      : body instanceof Uint8Array ? body.byteLength : 0
    counters.bytes += size
    if (play && (response.statusCode === 200 || response.statusCode === 206)) counters.mediaBytes += size
    if (play && response.statusCode === 206) counters.rangeBytes += size
  }
  response.write = new Proxy(response.write, {
    apply(target, receiver, args: unknown[]) { count(args); return Reflect.apply(target, receiver, args) }
  })
  response.end = new Proxy(response.end, {
    apply(target, receiver, args: unknown[]) { count(args); return Reflect.apply(target, receiver, args) }
  })
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    counters.activeRequests--
    if (!response.writableFinished) counters.abortedResponses++
    if (response.statusCode === 206) counters.partialResponses++
    if (response.statusCode === 401) counters.rejected401++
    if (response.statusCode === 404) counters.rejected404++
  }
  response.once('finish', finish)
  response.once('close', finish)
}
requests.subscribe(observe)

async function stop(): Promise<void> {
  if (stopped) return
  stopped = true
  try {
    await server?.stop()
  } finally {
    requests.unsubscribe(observe)
    setPlayGrantListener(null)
    closeDatabase()
    resetLibraryHostForTests()
  }
}

async function boot(): Promise<RemotePlaybackSource[]> {
  configureLibraryHost({ userDataPath: () => directory })
  const db = initDatabaseAtPath(path.join(directory, 'library.db'))
  ensureCatalogIdentity({ serverId: randomUUID() }, db)
  const timestamp = new Date().toISOString()
  const roots = new Map<string, number>()
  const resources = new Map<string, { videoId: number; fileId: number; label: string }>()
  const mapped = db.transaction(() => files.map((file, index) => {
    const existing = resources.get(file)
    if (existing) return existing
    const parent = path.dirname(file)
    let rootId = roots.get(parent)
    if (rootId === undefined) {
      const identity = resolveMediaLibraryRootIdentity(parent)
      const root = db.prepare(`INSERT INTO media_library_roots (
        library_id, path, normalized_path, real_path, normalized_real_path,
        device_id, inode, position, state, created_at, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
        identity.path, identity.normalizedPath, identity.realPath, identity.normalizedRealPath,
        identity.deviceId, identity.inode, roots.size, timestamp, timestamp
      )
      rootId = Number(root.lastInsertRowid)
      roots.set(parent, rootId)
    }
    const stat = fs.statSync(file)
    const inserted = insertTestVideoWithFile(db, {
      code: `LIBMPV-FIXTURE-${index + 1}`, title: path.basename(file),
      filePath: file, libraryId: 1, rootId, fileSize: stat.size
    })
    db.prepare('UPDATE video_resources SET file_mtime_ms = ? WHERE id = ?').run(stat.mtimeMs, inserted.fileId)
    const resource = { ...inserted, label: path.basename(file) }
    resources.set(file, resource)
    return resource
  }))()
  server = new WebServer({
    username: 'fixture-viewer', passwordHash: await hashPassword(generateSecret()),
    staticRoot: directory, catalog: new WebCatalog(db),
    sessions: new WebSessions(Date.now, path.join(directory, 'web-devices.json')),
    listenHost: '127.0.0.1', accessHosts: ['127.0.0.1'],
    manage: { appVersion: SERVER_APP_VERSION, dispatch: (context) => dispatchManageOperation(context, db) },
    play: { inspect: (input) => inspectPlayStream(input, db) }
  })
  server.setBrowserEnabled(false)
  setPlayGrantListener({ onRevoke: (ids) => closePlayStreams(ids) })
  const base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
  const post = async (operation: string, body: unknown, bearer?: string): Promise<Response> => fetch(
    `${base}/manage/v1/${operation}`, {
      method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: {
        Origin: base, 'Content-Type': 'application/json', 'X-Javdex-App-Version': SERVER_APP_VERSION,
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
      }, body: JSON.stringify(body)
    }
  )
  const read = async <T>(response: Response): Promise<T> => {
    const body = await response.json()
    // Do not log request URLs/credentials, including on fixture failures.
    assert.equal(response.status, 200, `Fixture manage request failed (${response.status})`)
    return body as T
  }
  const handshake = await read<{ identity: { serverId: string; catalogId: string } }>(
    await post('handshake.get', { input: {} })
  )
  const issued = issueOneTimeToken('initialBind', {}, db)
  const secret = generateSecret()
  const claimed = await read<{ status: string; bound: boolean; writerEpoch: number }>(await post('writer.claim', {
    ...handshake.identity,
    input: { kind: 'initialBind', oneTimeToken: issued.oneTimeToken, candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) } }
  }))
  assert.equal(claimed.status, 'consumed')
  assert.equal(claimed.bound, true)
  const envelope = (input: unknown) => ({ ...handshake.identity, writerEpoch: claimed.writerEpoch, input })
  const firstInput = { scope: { kind: 'library', libraryId: 1 }, videoId: mapped[0].videoId }
  const missing = await post('videos.get', envelope(firstInput))
  checks.missingBearer = missing.status
  await missing.arrayBuffer()
  assert.equal(checks.missingBearer, 401)
  const wrong = await post('videos.get', envelope(firstInput), generateSecret())
  checks.wrongBearer = wrong.status
  await wrong.arrayBuffer()
  assert.equal(checks.wrongBearer, 401)
  const sources: RemotePlaybackSource[] = []
  for (const item of mapped) {
    const detail = await read<{ id: number }>(await post('videos.get', envelope({ ...firstInput, videoId: item.videoId }), secret))
    assert.equal(detail.id, item.videoId)
    const resource = await read<{ id: number; locatorRevision: string }>(await post('videos.getResource', envelope({
      libraryId: 1, videoId: item.videoId, resourceId: item.fileId
    }), secret))
    assert.equal(resource.id, item.fileId)
    const grant = await read<PlayGrant>(await post('play.grant', envelope({
      libraryId: 1, videoId: item.videoId, resourceId: item.fileId, locatorRevision: resource.locatorRevision
    }), secret))
    const url = new URL(grant.playbackHandle)
    assert.equal(url.origin, base)
    assert.equal(grant.resourceId, item.fileId)
    sources.push({ playbackHandle: grant.playbackHandle, label: item.label })
  }
  const handle = sources[0].playbackHandle
  const head = await fetch(handle, { method: 'HEAD', signal: AbortSignal.timeout(10_000) })
  checks.head = head.status
  assert.equal(checks.head, 200)
  assert.equal(head.headers.get('accept-ranges'), 'bytes')
  assert.equal(Number(head.headers.get('content-length')), fs.statSync(files[0]).size)
  for (const [key, value] of [['missingPlayToken', ''], ['wrongPlayToken', generateSecret()]] as const) {
    const url = new URL(handle)
    if (value) url.searchParams.set('t', value)
    else url.searchParams.delete('t')
    const rejected = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    checks[key] = rejected.status
    await rejected.arrayBuffer()
    assert.equal(checks[key], 404)
  }
  const expected = Buffer.alloc(Math.min(16, fs.statSync(files[0]).size))
  const fd = fs.openSync(files[0], 'r')
  try { assert.equal(fs.readSync(fd, expected, 0, expected.length, 0), expected.length) }
  finally { fs.closeSync(fd) }
  const range = await fetch(handle, { headers: { Range: `bytes=0-${expected.length - 1}` }, signal: AbortSignal.timeout(10_000) })
  checks.range = range.status
  assert.equal(checks.range, 206)
  const actual = Buffer.from(await range.arrayBuffer())
  checks.bytesMatch = actual.equals(expected)
  assert.equal(checks.bytesMatch, true)
  startup = {
    requests: counters.requests, playRequests: counters.playRequests,
    rangeRequests: counters.rangeRequests, mediaBytes: counters.mediaBytes, rangeBytes: counters.rangeBytes
  }
  return sources
}

void (async () => {
  try {
    const sources = await boot()
    port.on('message', (message: { id: number; command: 'stats' | 'close' }) => {
      void (async () => {
        if (message.command === 'close') {
          revokeAllPlayGrants()
          await stop()
        }
        port.postMessage({ kind: 'reply', id: message.id, stats: snapshot() })
        if (message.command === 'close') port.close()
      })().catch(async (error: unknown) => {
        await stop().catch(() => {})
        port.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Fixture failed' })
        port.close()
      })
    })
    port.postMessage({ kind: 'ready', sources, stats: snapshot() })
  } catch (error) {
    await stop().catch(() => {})
    port.postMessage({ kind: 'error', message: error instanceof Error ? error.message : 'Fixture startup failed' })
    port.close()
  }
})()
