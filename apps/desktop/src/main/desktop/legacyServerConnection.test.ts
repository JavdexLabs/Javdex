import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { TLSSocket } from 'node:tls'
import { afterEach, test } from 'node:test'
import { testTls } from '../../../../../scripts/test-tls'
import { createDualProtocolServer } from '../../../../server/src/updater/dualProtocolServer'
import { createDesktopRuntime } from '../bootstrap/createDesktopRuntime'
import { createWriterCredentialStore } from './writerCredentialStore'
import { createThisComputerSettingsStore, thisComputerSettingsPath } from './thisComputerSettingsStore'
import { createServerConnectionStore } from './serverConnectionStore'
import { createLegacyServerConnection, legacyHttpsOrigin } from './legacyServerConnection'
import { createServerUpdateService } from './serverUpdateService'
import type { IpcContext } from '../ipc/shared'
import { getDb } from '@library/db/database'
import { ServerUpdateClient } from '@http/updateClient'

const version = '0.9.0-beta.7'
const serverId = '11111111-1111-4111-8111-111111111111'
const catalogId = '22222222-2222-4222-8222-222222222222'
const claimId = '33333333-3333-4333-8333-333333333333'
const secret = 'a'.repeat(64)
const hello = (appVersion = version, id = catalogId) => ({ protocolVersion: 1, appVersion, schemaVersion: appVersion === '0.8.0' ? 19 : 21,
  identity: { serverId, catalogId: id }, writerEpoch: 1, ready: 'ready' as const,
  capabilities: { encryptedAssets: false as const, transcoding: false as const, arbitraryUrlProxy: false as const,
    pluginExecution: false as const, publicInternetDefault: false as const, writerBound: true, browserEnabled: true, managementEnabled: true as const } })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-legacy-connection-'))
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }))
  const settings = createThisComputerSettingsStore(thisComputerSettingsPath(root))
  const credentials = createWriterCredentialStore({ userDataPath: root, cipher: { isAvailable: () => true,
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() } })
  await credentials.writeWriterSecret(catalogId, secret)
  const originalSecrets = fs.readFileSync(path.join(root, 'writer-secrets.json'))
  const connectionStore = createServerConnectionStore(root, { assertAvailable() {}, encrypt: value => Buffer.from(value), decrypt: value => value.toString() })
  let writerCalls = 0, httpCalls = 0, statusCode = 200, changedCatalog = catalogId
  let serverVersion = version
  let beforeWriter: (() => Promise<void>) | undefined
  const handle: http.RequestListener = async (request, response) => {
    for await (const _ of request) { /* Drain without storing credentials or request bodies. */ }
    response.setHeader('Content-Type', 'application/json')
    if (!(request.socket as TLSSocket).encrypted) {
      httpCalls++
      assert.equal(request.headers.authorization, undefined)
      assert.equal(request.headers.cookie, undefined)
      assert.equal(request.headers['x-javdex-app-version'], undefined)
      assert.equal(request.url, '/manage/v1/handshake.get')
      response.end(JSON.stringify(hello('0.8.0')))
    } else if (request.url === '/manage/v1/handshake.get') response.end(JSON.stringify(hello(serverVersion, changedCatalog)))
    else if (request.url === '/manage/v1/writer.status') {
      writerCalls++
      assert.equal(request.headers.authorization, `Bearer ${secret}`)
      await beforeWriter?.()
      response.statusCode = statusCode
      response.end(JSON.stringify({ bound: true, writerEpoch: 1, claimId, maintenanceBusy: false }))
    } else if (request.url === '/manage/v1/catalog.storageInfo') response.end(JSON.stringify({ imagesDir: '/data/images' }))
    else if (request.url === '/manage/v1/devices.list') response.end(JSON.stringify([{ id: claimId, name: '管理电脑', current: true, createdAt: '2026-01-01T00:00:00Z' }]))
    else if (request.url === '/update/v1/control') {
      assert.equal(request.headers.authorization, `Bearer ${secret}`)
      response.end(JSON.stringify({ protocolVersion: 1, paired: true, serverId, catalogId, currentVersion: version, platform: 'linux/amd64', targetVersion: null, job: null }))
    } else { response.statusCode = 404; response.end('{}') }
  }
  let server: http.Server | ReturnType<typeof createDualProtocolServer> | undefined
  const close = async () => {
    if (!server) return
    const current = server; server = undefined
    const done = new Promise<void>(resolve => current.close(() => resolve()))
    current.closeAllConnections()
    await done
  }
  cleanup.push(close)
  let port = 0
  const start = async (secure: boolean) => {
    await close()
    server = secure ? createDualProtocolServer(testTls(), handle) : http.createServer(handle)
    await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve))
    const address = server.address(); assert.ok(address && typeof address !== 'string')
    port = address.port
    return `http://127.0.0.1:${port}`
  }
  const runtime = async () => {
    const result = await createDesktopRuntime(root, version, { credentials, connectionStore, verifyCertificate: async () => {},
      detectDefaultPlayer: async () => ({ status: 'unavailable', message: 'isolated test' }) })
    cleanup.push(() => result.dispose())
    return result
  }
  return { root, settings, credentials, connectionStore, originalSecrets, start, runtime,
    get writerCalls() { return writerCalls }, get httpCalls() { return httpCalls },
    set statusCode(value: number) { statusCode = value }, set changedCatalog(value: string) { changedCatalog = value },
    set serverVersion(value: string) { serverVersion = value },
    set beforeWriter(value: (() => Promise<void>) | undefined) { beforeWriter = value } }
}

test('upgraded deployment automatically preserves the 0.8.0 authorization, completes pairing and survives restart', async () => {
  const f = await fixture()
  const address = await f.start(true)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  const runtime = await f.runtime()
  assert.equal(runtime.openedCatalog, false)
  assert.throws(() => getDb(), /Database not initialised/)
  assert.equal(runtime.backend.session().state, 'available')
  assert.equal((await f.settings.read()).remoteBaseUrl, address.replace('http:', 'https:'))
  assert.equal(f.connectionStore.read()!.pairing.token, secret)
  assert.equal(f.writerCalls, 1); assert.equal(f.httpCalls, 0)
  assert.deepEqual(await runtime.backend.devices!.list(), [{ id: claimId, name: '管理电脑', current: true, createdAt: '2026-01-01T00:00:00Z' }])
  const client = new ServerUpdateClient(f.connectionStore.read()!.pairing, async () => {})
  assert.equal((await client.control('status')).currentVersion, version, 'the existing credential also authorizes updates')
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'writer-secrets.json')), f.originalSecrets)
  await runtime.dispose(); cleanup.pop()
  const restarted = await f.runtime()
  assert.equal(restarted.backend.session().state, 'available')
  assert.equal(f.writerCalls, 1, 'do not migrate or issue credentials again')
})

test('client-only upgrade discovers 0.8.0 without credentials and reconnect migrates after the server upgrade', async () => {
  const f = await fixture()
  const address = await f.start(false)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  const runtime = await f.runtime()
  assert.equal(runtime.backend.session().state, 'versionMismatch')
  assert.equal(runtime.backend.session().appVersion, '0.8.0')
  assert.equal(runtime.backend.session().legacyHttpUpgradeRequired, true)
  assert.equal(f.connectionStore.read(), null)
  assert.equal((await f.settings.read()).remoteBaseUrl, address)
  assert.equal(f.httpCalls, 1); assert.equal(f.writerCalls, 0)
  const before = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = f.root
  try {
    const control = createServerUpdateService(runtime.backend, {} as IpcContext, f.settings,
      { queryEnvironment: async () => { assert.fail('old HTTP discovery already proves that this image needs upgrading') } })
    assert.equal((await control({ action: 'environment' })).environment?.state, 'imageRequired')
    await assert.rejects(control({ action: 'check', targetVersion: version }), /0.8.0.*Docker/)
  } finally { if (before === undefined) delete process.env.JAVDEX_TEST_USER_DATA; else process.env.JAVDEX_TEST_USER_DATA = before }
  await f.start(true)
  await runtime.backend.reconnect()
  assert.equal(runtime.backend.session().state, 'available')
  assert.equal(runtime.backend.session().legacyHttpUpgradeRequired, false)
  assert.equal(f.connectionStore.read()!.pairing.token, secret)
  assert.equal((await f.settings.read()).remoteBaseUrl, address.replace('http:', 'https:'))
})

test('a remembered old server identity survives restart and manual HTTPS address correction', async () => {
  const f = await fixture()
  const address = await f.start(false)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  const first = await f.runtime()
  assert.equal(first.backend.session().legacyHttpUpgradeRequired, true)
  await first.dispose(); cleanup.pop()
  f.changedCatalog = '44444444-4444-4444-8444-444444444444'
  await f.start(true)
  const restarted = await f.runtime()
  assert.equal(restarted.backend.session().state, 'disconnected')
  assert.match(restarted.backend.session().message!, /身份已变化/)
  await restarted.dispose(); cleanup.pop()
  await f.settings.write({ remoteBaseUrl: address.replace('http:', 'https:') })
  const corrected = await f.runtime()
  assert.equal(corrected.backend.session().state, 'disconnected')
  assert.match(corrected.backend.session().message!, /身份已变化/)
  assert.equal(f.writerCalls, 0)
})

test('an old server behind TLS can still finish migration after upgrading, including a manually corrected address', async () => {
  for (const inputScheme of ['http:', 'https:']) {
    const f = await fixture()
    const address = (await f.start(true)).replace('http:', inputScheme)
    f.serverVersion = '0.8.0'
    await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
    const runtime = await f.runtime()
    assert.equal(runtime.backend.session().legacyHttpUpgradeRequired, true)
    assert.equal(runtime.backend.session().state, 'versionMismatch')
    assert.equal(f.writerCalls, 0)
    f.serverVersion = version
    await runtime.backend.reconnect()
    assert.equal(runtime.backend.session().state, 'available')
    assert.equal(f.connectionStore.read()!.pairing.token, secret)
    assert.equal(f.httpCalls, 0)
    await runtime.dispose(); cleanup.pop()
  }
})

test('revoked credentials and unknown catalogs preserve the old configuration and authorization', async () => {
  for (const failure of ['revoked', 'different catalog']) {
    const f = await fixture()
    const address = await f.start(true)
    await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
    if (failure === 'revoked') f.statusCode = 401
    else f.changedCatalog = '44444444-4444-4444-8444-444444444444'
    const runtime = await f.runtime()
    assert.equal(runtime.backend.session().state, failure === 'revoked' ? 'authInvalid' : 'recoveryRequired')
    assert.equal(f.connectionStore.read(), null)
    assert.equal((await f.settings.read()).remoteBaseUrl, address)
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'writer-secrets.json')), f.originalSecrets)
    await runtime.dispose(); cleanup.pop()
  }
})

test('identity changes after old HTTP discovery are rejected before sending the saved credential', async () => {
  const f = await fixture()
  await f.settings.write({ mode: 'remote', remoteBaseUrl: await f.start(false) })
  const runtime = await f.runtime()
  f.changedCatalog = '44444444-4444-4444-8444-444444444444'
  await f.start(true)
  await runtime.backend.reconnect()
  assert.equal(runtime.backend.session().state, 'disconnected')
  assert.match(runtime.backend.session().message!, /身份已变化/)
  assert.equal(f.writerCalls, 0); assert.equal(f.connectionStore.read(), null)
})

test('a refused certificate never triggers HTTP discovery or sends the old credential', async () => {
  const f = await fixture()
  const address = await f.start(true)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  const prepared = createLegacyServerConnection({ address, appVersion: version, settings: f.settings, connectionStore: f.connectionStore,
    verifyCertificate: async () => { throw new Error('证书已变化，取消连接') } })
  await assert.rejects(prepared.migration.handshake!(), /fetch failed/)
  assert.equal(f.httpCalls, 0); assert.equal(f.writerCalls, 0)
  assert.equal(f.connectionStore.read(), null)
})

test('changing the configured target during authorization prevents saving a stale migration', async () => {
  const f = await fixture()
  const address = await f.start(true)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  f.beforeWriter = async () => { await f.settings.write({ mode: 'local', remoteBaseUrl: 'https://other.example' }) }
  const runtime = await f.runtime()
  assert.equal(runtime.backend.session().state, 'disconnected')
  assert.equal((await f.settings.read()).remoteBaseUrl, 'https://other.example')
  assert.equal(f.connectionStore.read(), null)
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'writer-secrets.json')), f.originalSecrets)
})

test('a settings write interrupted after saving the connection can finish with the same original secret', async () => {
  const f = await fixture()
  const address = await f.start(true)
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  let fail = true
  const settings = { ...f.settings, write: async (...args: Parameters<typeof f.settings.write>) => {
    if (fail) { fail = false; throw new Error('simulated settings write interruption') }
    return f.settings.write(...args)
  } }
  const prepare = () => createLegacyServerConnection({ address, appVersion: version, settings, connectionStore: f.connectionStore, verifyCertificate: async () => {} })
  await assert.rejects(prepare().migration.complete(hello(), secret), /settings write interruption/)
  assert.equal(f.connectionStore.read()!.pairing.token, secret)
  assert.equal((await f.settings.read()).remoteBaseUrl, address)
  await prepare().migration.complete(hello(), secret)
  assert.equal((await f.settings.read()).remoteBaseUrl, address.replace('http:', 'https:'))
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'writer-secrets.json')), f.originalSecrets)
  assert.equal(legacyHttpsOrigin('http://nas.local'), 'https://nas.local:80')
})

test('extra public identity fields cannot override the authenticated secret, origin or certificate', async () => {
  const f = await fixture()
  const address = (await f.start(true)).replace('http:', 'https:')
  await f.settings.write({ mode: 'remote', remoteBaseUrl: address })
  const prepared = createLegacyServerConnection({ address, appVersion: version, settings: f.settings, connectionStore: f.connectionStore, verifyCertificate: async () => {} })
  const response = { ...hello(), identity: { ...hello().identity, token: 'b'.repeat(64), url: 'https://other.example', certificateSha256: '0'.repeat(64) } }
  await prepared.migration.complete(response, secret)
  const saved = f.connectionStore.read()!
  assert.equal(saved.pairing.token, secret)
  assert.equal(saved.remoteBaseUrl, address)
  assert.notEqual(saved.pairing.certificateSha256, '0'.repeat(64))
})
