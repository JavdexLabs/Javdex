import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { it, type TestContext } from 'node:test'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'

async function fixture(t: TestContext) {
  const authorization: string[] = []
  const credentialReads: string[] = []
  const savedSecret = 'saved-device-credential'
  const advertised = { serverId: 'server-1', catalogId: 'catalog-1' }
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain uploads before responding. */ }
    if (request.headers.authorization) authorization.push(request.headers.authorization)
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/manage/v1/handshake.get') response.end(JSON.stringify({
      protocolVersion: 1, appVersion: '0.9.0', schemaVersion: 21,
      identity: advertised, writerEpoch: 1, ready: 'ready'
    }))
    else if (request.url === '/manage/v1/catalog.storageInfo') response.end(JSON.stringify({ imagesDir: '/data/images' }))
    else if (request.url === '/manage/v1/backup.control') response.end(JSON.stringify({ jobs: [] }))
    else if (request.method === 'PUT') response.end(JSON.stringify({ offset: 1 }))
    else response.end('[]')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const backend = createRemoteCatalogBackend({
    baseUrl: `http://127.0.0.1:${address.port}`, appVersion: '0.9.0',
    deviceIdentity: { serverId: 'server-1', secret: savedSecret },
    credentials: {
      isAvailable: async () => true,
      readWriterSecret: async catalogId => { credentialReads.push(catalogId); return catalogId === 'catalog-1' ? savedSecret : null },
      writeWriterSecret: async () => { assert.fail('read-only checks must not rewrite credentials') },
      deleteWriterSecret: async () => { assert.fail('identity mismatch must preserve saved credentials') }
    }
  })
  t.after(async () => {
    await backend.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { backend, advertised, authorization, credentialReads }
}

it('rejects a different server advertising a known catalog before reading or sending its credential', async t => {
  const f = await fixture(t)
  f.advertised.serverId = 'replacement-server'
  assert.equal((await f.backend.reconnect()).state, 'disconnected')
  assert.deepEqual(f.credentialReads, [])
  assert.deepEqual(f.authorization, [])
  await assert.rejects(f.backend.libraries.list({}), { code: 'INSTANCE_MISMATCH' })
  assert.deepEqual(f.authorization, [])
})

for (const action of ['list', 'upload', 'download'] as const) {
  it(`backup ${action} refuses a different server before reading or sending credentials`, async t => {
    const f = await fixture(t)
    f.advertised.serverId = 'replacement-server'
    const backup = f.backend.backup!
    await assert.rejects(action === 'list' ? backup.request({ action: 'list' })
      : action === 'upload' ? backup.upload('backup', 0, Buffer.from('x')) : backup.download('backup', 0), { code: 'INSTANCE_MISMATCH' })
    assert.deepEqual(f.credentialReads, [])
    assert.deepEqual(f.authorization, [])
  })
}

it('keeps using the saved device on the same server after an authorized catalog restore', async t => {
  const f = await fixture(t)
  assert.equal((await f.backend.reconnect()).state, 'available')
  f.advertised.catalogId = 'restored-catalog'
  assert.equal((await f.backend.reconnect()).state, 'available')
  assert.deepEqual(await f.backend.backup!.request({ action: 'list' }), { jobs: [] })
  assert.equal(f.backend.session().catalogId, 'restored-catalog')
  assert.equal(f.authorization.length, 3)
})
