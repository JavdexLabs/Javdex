import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { it } from 'node:test'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'
import { structuredError } from '@shared/protocol/errors'

it('requires first authorization on an unbound server even with a stale cached writer secret', async () => {
  let serverVersion = '0.8.0-beta.1'
  const server = createServer((request, response) => {
    assert.equal(request.url, '/manage/v1/handshake.get')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({
      appVersion: serverVersion, schemaVersion: 1,
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
    assert.equal(backend.session().desktopAppVersion, '0.8.0-beta.1')
    assert.equal(backend.session().appVersion, null, 'an unknown server version must not fall back to the desktop version')
    const session = await backend.reconnect()
    assert.equal(session.state, 'claimRequired')
    assert.equal(session.writerEpoch, 0)
    assert.equal(session.remoteBaseUrl, `http://127.0.0.1:${address.port}`)
    assert.equal(session.appVersion, serverVersion)
    serverVersion = '0.8.0-beta.3'
    const mismatch = await backend.reconnect()
    assert.equal(mismatch.state, 'versionMismatch')
    assert.equal(mismatch.desktopAppVersion, '0.8.0-beta.1')
    assert.equal(mismatch.appVersion, '0.8.0-beta.3')
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

type TestAuthError = 'AUTH_REQUIRED' | 'WRITER_REVOKED' | 'INVALID_INPUT'

async function authFixture() {
  const calls: string[] = []
  let epoch = 1
  let rejectedRoute = ''
  let metadataAbsent = false
  let storedSecret = 'old-secret'
  let rejectCode: TestAuthError = 'AUTH_REQUIRED'
  let holdRoute = ''
  let release: (code?: TestAuthError) => void = () => undefined
  let arrived: () => void = () => undefined
  let hold: Promise<TestAuthError | undefined> = Promise.resolve(undefined)
  const server = createServer(async (request, response) => {
    const route = request.url!.split('/').at(-1)!
    calls.push(route)
    for await (const _ of request) { /* Drain uploads before responding. */ }
    const shouldReject = route === rejectedRoute
    let heldError: TestAuthError | undefined
    if (route === holdRoute) { arrived(); heldError = await hold }
    response.setHeader('Content-Type', 'application/json')
    if (route === 'handshake.get') return response.end(JSON.stringify({
      appVersion: '0.8.0-beta.1', schemaVersion: 19,
      identity: { serverId: 'server-1', catalogId: 'catalog-1' }, writerEpoch: epoch, ready: 'ready'
    }))
    if (shouldReject || heldError) {
      response.statusCode = 401
      return response.end(JSON.stringify(structuredError(heldError ?? rejectCode, '测试授权错误')))
    }
    if (route === 'catalog.storageInfo' && metadataAbsent) {
      response.statusCode = 404
      return response.end(JSON.stringify(structuredError('UNSUPPORTED_CAPABILITY', '旧服务端没有图片目录信息')))
    }
    response.end(JSON.stringify(route === 'writer.claim' ? { status: 'consumed', bound: true, writerEpoch: 2, claimId: 'claim' }
      : route === 'catalog.storageInfo' ? { imagesDir: '/data/images' }
        : route === 'libraries.list' ? [] : route === 'videos.edit' ? true : {}))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const backend = createRemoteCatalogBackend({ baseUrl: `http://127.0.0.1:${address.port}`, appVersion: '0.8.0-beta.1', credentials: {
    isAvailable: async () => true, readWriterSecret: async () => storedSecret,
    writeWriterSecret: async (_id, secret) => { storedSecret = secret }, deleteWriterSecret: async () => undefined
  } })
  return { backend, calls, reject: (route: string, code = 'AUTH_REQUIRED' as typeof rejectCode) => { rejectedRoute = route; rejectCode = code },
    epoch: (value: number) => { epoch = value },
    pause: (route: string) => { holdRoute = route; hold = new Promise<TestAuthError | undefined>(resolve => { release = resolve }); return new Promise<void>(resolve => { arrived = resolve }) },
    release: (code?: TestAuthError) => { holdRoute = ''; release(code) },
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
    const publicSession = JSON.stringify(f.backend.session())
    assert.ok(!publicSession.includes(f.secret()))
    assert.doesNotMatch(publicSession, /"(?:writerToken|oneTimeToken|writerSecret)":/)
  } finally { await f.close() }
})

it('a delayed old-epoch rejection cannot invalidate a device after another request refreshes its fence', { timeout: 5_000 }, async t => {
  let epoch = 1
  const staleResponses = new Map<boolean, ServerResponse>()
  let bothArrived: () => void = () => undefined
  const bothOldRequests = new Promise<void>(resolve => { bothArrived = resolve })
  const server = createServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text) as { writerEpoch?: number; input: { includeArchived?: boolean } }
    const route = request.url!.split('/').at(-1)!
    response.setHeader('Content-Type', 'application/json')
    if (route === 'handshake.get') return response.end(JSON.stringify({
      appVersion: '0.9.0', schemaVersion: 21,
      identity: { serverId: 'server-1', catalogId: 'catalog-1' }, writerEpoch: epoch, ready: 'ready'
    }))
    if (route === 'libraries.list' && body.writerEpoch !== epoch) {
      assert.equal(body.writerEpoch, 1)
      staleResponses.set(body.input.includeArchived === true, response)
      if (staleResponses.size === 2) bothArrived()
      return
    }
    if (route === 'writer.status') {
      assert.equal(request.headers.authorization, 'Bearer active-device-secret')
      assert.equal(body.writerEpoch, epoch)
    }
    response.end(JSON.stringify(route === 'catalog.storageInfo' ? { imagesDir: '/data/images' }
      : route === 'libraries.list' ? [] : { writerEpoch: epoch, bound: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const backend = createRemoteCatalogBackend({ baseUrl: `http://127.0.0.1:${address.port}`, appVersion: '0.9.0', credentials: {
    isAvailable: async () => true, readWriterSecret: async () => 'active-device-secret',
    writeWriterSecret: async () => undefined, deleteWriterSecret: async () => undefined
  } })
  t.after(async () => {
    server.closeAllConnections()
    await backend.dispose()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  assert.equal((await backend.reconnect()).state, 'available')
  const states: string[] = []
  backend.onSessionChanged!(() => states.push(backend.session().state))
  epoch = 2 // Another device was revoked; this device's credential remains valid.
  const first = backend.libraries.list({ includeArchived: false })
  const second = backend.libraries.list({ includeArchived: true })
  const settled = Promise.allSettled([first, second])
  await bothOldRequests
  const rejectOldRequest = (includeArchived: boolean): void => {
    const response = staleResponses.get(includeArchived)!
    response.statusCode = 409
    response.end(JSON.stringify(structuredError('WRITER_REVOKED', '写入代次已变化')))
  }
  rejectOldRequest(false)
  assert.deepEqual(await first, [])
  assert.equal(backend.session().writerEpoch, 2)
  // The second old response arrives only after the first refresh AND retry finish.
  rejectOldRequest(true)
  const results = await settled
  assert.equal(backend.session().state, 'available', 'a stale response must not revoke an active device')
  assert.deepEqual(results, [{ status: 'fulfilled', value: [] }, { status: 'fulfilled', value: [] }])
  assert.deepEqual(states, [], 'a shared fence refresh is not an authorization failure')
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

for (const statusError of ['AUTH_REQUIRED', undefined] as const) {
  it(`an old writer.status ${statusError ?? 'success'} cannot revoke or replay a mutation after reconnection`, { timeout: 5_000 }, async () => {
    const f = await authFixture()
    try {
      assert.equal((await f.backend.reconnect()).state, 'available')
      f.epoch(2)
      f.reject('videos.edit', 'WRITER_REVOKED')
      const statusArrived = f.pause('writer.status')
      const pending = Promise.allSettled([f.backend.videos.edit({ videoId: 1, fields: { title: 'old draft' } }, mutation)])
      await statusArrived
      assert.equal(f.calls.filter(route => route === 'videos.edit').length, 1)
      f.reject('')
      const reconnected = await f.backend.reconnect()
      assert.equal(reconnected.state, 'available')
      assert.equal(reconnected.writerEpoch, 2)
      const states: string[] = []
      f.backend.onSessionChanged!(() => states.push(f.backend.session().state))
      // Release the old status only once the replacement session is authenticated.
      f.release(statusError)
      const [result] = await pending
      assert.equal(f.backend.session().state, 'available', 'an old status rejection must not revoke the replacement session')
      assert.equal(f.backend.session().generation, reconnected.generation)
      assert.equal(f.calls.filter(route => route === 'videos.edit').length, 1, 'an old mutation must not be replayed into the replacement session')
      assert.deepEqual(states, [])
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.equal(result.reason.code, 'CONNECTION_UNAVAILABLE')
      await f.backend.libraries.list({})
    } finally { await f.close() }
  })
}

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
