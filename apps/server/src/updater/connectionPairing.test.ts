import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ConnectionPairing } from './connectionPairing'
import { WebServer } from '@http/server'
import { WebCatalog } from '@http/catalog'
import { WebSessions } from '@http/auth'
import { closeDatabase, initDatabaseAtPath } from '@library/db/database'
import { configureLibraryHost, resetLibraryHostForTests } from '@library/runtime/host'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { authenticateWriter, issueOneTimeToken, listTrustedDevices } from '@library/catalog/catalogWriter'
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import { dispatchManageOperation } from '../manageDispatch'
import { SERVER_APP_VERSION } from '../appVersion'
import { requestBusiness } from './businessHttp'

test('one-time connection grant binds a durable candidate and resumes after a lost response', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-connect-'))
  let now = Date.now()
  try {
    const store = new ConnectionPairing(root, () => now)
    const grant = store.issue({ kind: 'initialBind', oneTimeToken: 'writer-token', serverId: randomUUID(), catalogId: randomUUID(), expiresAt: new Date(now + 600000).toISOString() })
    const request = { code: grant.code, claimId: randomUUID(), secretDigest: 'a'.repeat(64), appVersion: '0.9.0' }
    await assert.rejects(store.claim({ ...request, code: '0'.repeat(64) }, async () => assert.fail()), /无效/)
    await assert.rejects(store.claim(request, async () => { throw new Error('response lost') }), /response lost/)
    now += 700000
    const restart = new ConnectionPairing(root, () => now)
    assert.equal(await restart.claim(request, async (issued, candidate) => {
      assert.equal(issued.oneTimeToken, 'writer-token'); assert.equal(candidate.claimId, request.claimId); return 'same durable receipt'
    }), 'same durable receipt')
    await assert.rejects(restart.claim({ ...request, claimId: randomUUID() }, async () => assert.fail()), /另一台/)
    const next = store.issue({ kind: 'deployRecover', oneTimeToken: 'recovery-token', serverId: grant.serverId, catalogId: grant.catalogId, expiresAt: new Date(now + 600000).toISOString() })
    await assert.rejects(store.claim(request, async () => assert.fail()), /无效/)
    now += 600001
    await assert.rejects(store.claim({ ...request, code: next.code }, async () => assert.fail()), /过期/)
    assert.ok(!fs.readFileSync(path.join(root, 'connection-grant.json'), 'utf8').includes(next.code))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('unified pairing claims real business credentials and independently adds a second device', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-connect-business-'))
  let server: WebServer | undefined
  try {
    configureLibraryHost({ userDataPath: () => root })
    const db = initDatabaseAtPath(path.join(root, 'library.db'))
    const identity = ensureCatalogIdentity({ serverId: randomUUID() }, db)
    assert.ok(identity.serverId)
    const expectedIdentity = { serverId: identity.serverId, catalogId: identity.catalogId }
    server = new WebServer({
      username: 'fixture', passwordHash: 'unused', staticRoot: root,
      catalog: new WebCatalog(db), sessions: new WebSessions(Date.now, path.join(root, 'web-devices.json')),
      listenHost: '127.0.0.1', accessHosts: ['127.0.0.1'],
      manage: { appVersion: SERVER_APP_VERSION, dispatch: context => dispatchManageOperation(context, db) }
    })
    server.setBrowserEnabled(false)
    const base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
    const store = new ConnectionPairing(root)
    const secrets: string[] = []
    for (const kind of ['initialBind', 'deviceAdd'] as const) {
      const grant = store.issue(issueOneTimeToken(kind, {}, db))
      const secret = generateSecret()
      const request = { code: grant.code, claimId: randomUUID(), secretDigest: digestToken(secret), name: kind, appVersion: SERVER_APP_VERSION }
      const consume = async (issued: { serverId: string; catalogId: string; kind: string; oneTimeToken: string }, candidate: { claimId: string; secretDigest: string; name?: string }) => {
        const response = await requestBusiness(new URL('/manage/v1/writer.claim', base), new URL(base).host, {
          appVersion: SERVER_APP_VERSION,
          body: JSON.stringify({ serverId: issued.serverId, catalogId: issued.catalogId,
            input: { kind: issued.kind, oneTimeToken: issued.oneTimeToken, candidate } })
        })
        assert.equal(response.status, 200, response.body)
        const receipt = JSON.parse(response.body) as { status: string; bound: boolean }
        assert.equal(receipt.status, 'consumed')
        assert.equal(receipt.bound, true)
        return receipt
      }
      const receipt = await store.claim(request, consume)
      assert.deepEqual(await store.claim(request, consume), receipt, 'lost-response retry uses the same writer receipt')
      secrets.push(secret)
      for (const previous of secrets) assert.equal(authenticateWriter(previous, expectedIdentity, db).epoch, 1)
      assert.equal(listTrustedDevices(request.claimId, db).length, secrets.length)
    }
  } finally {
    await server?.stop()
    closeDatabase()
    resetLibraryHostForTests()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
