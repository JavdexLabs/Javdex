import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { it } from 'node:test'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'
import { structuredError } from '@shared/protocol/errors'

it('requires first authorization on an unbound server even with a stale cached writer secret', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/manage/v1/handshake.get')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      appVersion: '0.8.0-beta.1', schemaVersion: 1,
      identity: { serverId: 'server-1', catalogId: 'catalog-1' },
      writerEpoch: 0, ready: 'notBound'
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const backend = createRemoteCatalogBackend({
      baseUrl: `http://127.0.0.1:${address.port}`,
      appVersion: '0.8.0-beta.1',
      credentials: {
        isAvailable: async () => true,
        readWriterSecret: async () => 'obsolete-secret',
        writeWriterSecret: async () => undefined,
        deleteWriterSecret: async () => undefined
      }
    })
    const session = await backend.reconnect()
    assert.equal(session.state, 'claimRequired')
    assert.equal(session.writerEpoch, 0)
    assert.equal(session.remoteBaseUrl, `http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

async function authFixture() {
  const calls: string[] = []
  let rejectedRoute = ''
  let metadataAbsent = false
  let storedSecret = 'old-secret'
  let rejectCode: 'AUTH_REQUIRED' | 'WRITER_REVOKED' | 'INVALID_INPUT' = 'AUTH_REQUIRED'
  let holdRoute = ''
  let release: () => void = () => undefined
  let arrived: () => void = () => undefined
  let hold: Promise<void> = Promise.resolve()
  const server = createServer(async (request, response) => {
    const route = request.url!.split('/').at(-1)!
    calls.push(route)
    for await (const _ of request) { /* Drain uploads before responding. */ }
    const shouldReject = route === rejectedRoute
    if (route === holdRoute) { arrived(); await hold }
    response.setHeader('Content-Type', 'application/json')
    if (route === 'handshake.get') return response.end(JSON.stringify({
      appVersion: '0.8.0-beta.1', schemaVersion: 19,
      identity: { serverId: 'server-1', catalogId: 'catalog-1' }, writerEpoch: 1, ready: 'ready'
    }))
    if (shouldReject) {
      response.statusCode = 401
      return response.end(JSON.stringify(structuredError(rejectCode, '测试授权错误')))
    }
    if (route === 'catalog.storageInfo' && metadataAbsent) {
      response.statusCode = 404
      return response.end(JSON.stringify(structuredError('UNSUPPORTED_CAPABILITY', '旧服务端没有图片目录信息')))
    }
    response.end(JSON.stringify(route === 'writer.claim' ? { status: 'consumed', bound: true, writerEpoch: 2, claimId: 'claim' }
      : route === 'catalog.storageInfo' ? { imagesDir: '/data/images' }
        : route === 'libraries.list' ? [] : {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const backend = createRemoteCatalogBackend({ baseUrl: `http://127.0.0.1:${address.port}`, appVersion: '0.8.0-beta.1', credentials: {
    isAvailable: async () => true, readWriterSecret: async () => storedSecret,
    writeWriterSecret: async (_id, secret) => { storedSecret = secret }, deleteWriterSecret: async () => undefined
  } })
  return { backend, calls, reject: (route: string, code = 'AUTH_REQUIRED' as typeof rejectCode) => { rejectedRoute = route; rejectCode = code },
    pause: (route: string) => { holdRoute = route; hold = new Promise<void>(resolve => { release = resolve }); return new Promise<void>(resolve => { arrived = resolve }) },
    release: () => { holdRoute = ''; release() },
    omitMetadata: () => { metadataAbsent = true }, secret: () => storedSecret,
    close: async () => { release(); await backend.dispose(); await new Promise<void>(resolve => server.close(() => resolve())) } }
}

it('does not report connected when the metadata request rejects the stored credential', async () => {
  const f = await authFixture()
  try {
    f.reject('catalog.storageInfo')
    assert.equal((await f.backend.reconnect()).state, 'authInvalid')
    const count = f.calls.length
    await assert.rejects(f.backend.libraries.list({}), { code: 'AUTH_REQUIRED' })
    assert.equal(f.calls.length, count)
  } finally { await f.close() }
})

it('validates authentication separately when an older server lacks optional metadata', async () => {
  const f = await authFixture()
  try {
    f.omitMetadata()
    f.reject('writer.status')
    assert.equal((await f.backend.reconnect()).state, 'authInvalid')
    f.reject('')
    assert.equal((await f.backend.reconnect()).state, 'available')
    assert.equal(f.backend.session().remoteImagesDir, null)
  } finally { await f.close() }
})

const id = 'aa31510e-6389-48d9-ad58-225635954dbc'
const mutation = { operationId: id, expectedVersions: {} }
for (const [name, route, run] of [
  ['query', 'libraries.list', (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.libraries.list({})],
  ['write', 'videos.edit', (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.videos.edit({ videoId: 1, fields: { title: 'draft' } }, mutation)],
  ['image upload', id, (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.assets.putUpload({ uploadId: id, body: Buffer.from('image'), contentType: 'image/png' })],
  ['image read', 'cover.jpg', (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.assets.readImage({ relPath: 'covers/cover.jpg' })],
  ['backup request', 'backup.control', (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.backup.request({ action: 'list' })],
  ['backup download', `${id}?offset=0`, (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.backup.download(id, 0)],
  ['backup upload', `${id}?offset=0`, (backend: ReturnType<typeof createRemoteCatalogBackend>) => backend.backup.upload(id, 0, Buffer.from('backup'))]
] as const) it(`${name} latches revoked authorization, broadcasts once and resumes only after explicit recovery`, async () => {
  const f = await authFixture()
  try {
    await f.backend.reconnect()
    const states: string[] = []
    f.backend.onSessionChanged!(() => states.push(f.backend.session().state))
    f.reject(route, 'WRITER_REVOKED')
    await assert.rejects(run(f.backend), { code: 'WRITER_REVOKED' })
    assert.equal(f.backend.session().state, 'authInvalid')
    assert.deepEqual(states, ['authInvalid'])
    const count = f.calls.length
    await assert.rejects(f.backend.libraries.list({}), { code: 'AUTH_REQUIRED' })
    await assert.rejects(f.backend.backup.request({ action: 'list' }), { code: 'AUTH_REQUIRED' })
    assert.equal(f.calls.length, count, 'polling and repeated writes must not resend stale credentials')
    f.reject('writer.claim')
    await assert.rejects(f.backend.claimWriter({ kind: 'deployRecover', oneTimeToken: 'bad-token' }))
    assert.equal(f.backend.session().state, 'authInvalid')
    f.reject('')
    await f.backend.claimWriter({ kind: 'deployRecover', oneTimeToken: 'new-token' })
    assert.equal(f.backend.session().state, 'available')
    assert.notEqual(f.secret(), 'old-secret')
    assert.equal(f.calls.filter(call => call === route).length, 1, 'failed operations must not be replayed automatically')
    await f.backend.libraries.list({})
  } finally { await f.close() }
})

it('ordinary validation errors leave the authenticated session usable', async () => {
  const f = await authFixture()
  try {
    await f.backend.reconnect()
    f.reject('videos.edit', 'INVALID_INPUT')
    await assert.rejects(f.backend.videos.edit({ videoId: 1, fields: {} }, mutation), { code: 'INVALID_INPUT' })
    assert.equal(f.backend.session().state, 'available')
    await f.backend.libraries.list({})
  } finally { await f.close() }
})

it('reconnection aborts an old request and its late rejection cannot revoke the new session', async () => {
  const f = await authFixture()
  try {
    await f.backend.reconnect()
    f.reject('libraries.list')
    const arrived = f.pause('libraries.list')
    const rejected = assert.rejects(f.backend.libraries.list({}), { code: 'CONNECTION_UNAVAILABLE' })
    await arrived
    f.reject('')
    assert.equal((await f.backend.reconnect()).state, 'available')
    f.release()
    await rejected
    assert.equal(f.backend.session().state, 'available')
    await f.backend.libraries.list({})
  } finally { await f.close() }
})

it('one rejected credential aborts another active request without repeating state notifications', async () => {
  const f = await authFixture()
  try {
    await f.backend.reconnect()
    const arrived = f.pause('libraries.list')
    const rejected = assert.rejects(f.backend.libraries.list({}), { code: 'CONNECTION_UNAVAILABLE' })
    await arrived
    const states: string[] = []
    f.backend.onSessionChanged!(() => states.push(f.backend.session().state))
    f.reject('videos.edit')
    await assert.rejects(f.backend.videos.edit({ videoId: 1, fields: { title: 'edit' } }, mutation), { code: 'AUTH_REQUIRED' })
    f.release()
    await rejected
    assert.deepEqual(states, ['authInvalid'])
  } finally { await f.close() }
})

it('does not send a query when its caller already cancelled it', async () => {
  const f = await authFixture()
  try {
    await f.backend.reconnect()
    const before = [...f.calls]
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(f.backend.queries.overviewStats({}, { signal: controller.signal }))
    assert.deepEqual(f.calls, before)
    assert.equal(f.backend.session().state, 'available')
  } finally { await f.close() }
})
