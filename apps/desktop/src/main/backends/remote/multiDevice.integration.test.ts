import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebServer } from '@http/server'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { ensureCatalogIdentity } from '@library/catalog/catalogIdentity'
import { claimWriter, issueOneTimeToken } from '@library/catalog/catalogWriter'
import { digestToken, generateSecret } from '@library/catalog/catalogSecrets'
import { readVideoAggregateVersion } from '@library/catalog/catalogVideoVersion'
import { dispatchManageOperation } from '../../../../../server/src/manageDispatch'
import { SERVER_APP_VERSION } from '../../../../../server/src/appVersion'
import { createRemoteCatalogBackend } from './remoteCatalogBackend'

test('three real HTTP clients edit with conflict detection; revoking one preserves the other two', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-multi-http-'))
  const previousRoot = process.env.JAVDEX_TEST_USER_DATA
  process.env.JAVDEX_TEST_USER_DATA = root
  const clients: ReturnType<typeof createRemoteCatalogBackend>[] = []
  initDatabaseAtPath(path.join(root, 'library.db'))
  const identity = ensureCatalogIdentity({ serverId: randomUUID() })
  const videoId = Number(getDb().prepare("INSERT INTO videos(code,title) VALUES ('MULTI-001','Original')").run().lastInsertRowid)
  const server = new WebServer({ staticRoot: root, username: 'viewer', passwordHash: '',
    catalog: { home: () => ({ discovery: [], recent: [] }), collections: () => ({ libraries: [], playlists: [] }), browse: () => ({ items: [], total: 0, page: 1, pageSize: 36 }),
      detail: () => { throw new Error('unused') }, image: async () => { throw new Error('unused') }, media: () => { throw new Error('unused') } },
    manage: { appVersion: SERVER_APP_VERSION, dispatch: context => dispatchManageOperation(context) }
  })
  try {
    const baseUrl = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`
    for (let index = 0; index < 3; index++) {
      const kind = index === 0 ? 'initialBind' : 'deviceAdd'
      const issued = issueOneTimeToken(kind)
      const secret = generateSecret()
      claimWriter({ kind, oneTimeToken: issued.oneTimeToken, candidate: { claimId: randomUUID(), secretDigest: digestToken(secret), name: `Device ${index + 1}` } })
      const backend = createRemoteCatalogBackend({ baseUrl, appVersion: SERVER_APP_VERSION, deviceIdentity: { serverId: identity.serverId!, secret }, credentials: {
        isAvailable: async () => true, readWriterSecret: async catalogId => catalogId === identity.catalogId ? secret : null,
        writeWriterSecret: async () => {}, deleteWriterSecret: async () => {}
      } })
      clients.push(backend)
      assert.equal((await backend.reconnect()).state, 'available')
    }
    const version = readVideoAggregateVersion(videoId)!
    const context = () => ({ operationId: randomUUID(), expectedVersions: { V: version } })
    assert.equal(await clients[0].videos.edit({ videoId, fields: { title: 'First edit' } }, context()), true)
    await assert.rejects(clients[1].videos.edit({ videoId, fields: { title: 'Stale edit' } }, context()), { code: 'VERSION_CONFLICT' })
    assert.equal((getDb().prepare('SELECT title FROM videos WHERE id=?').get(videoId) as { title: string }).title, 'First edit')
    assert.equal(await clients[1].videos.edit({ videoId, fields: { title: 'Refreshed edit' } }, { operationId: randomUUID(), expectedVersions: { V: readVideoAggregateVersion(videoId)! } }), true)
    const devices = await clients[0].devices!.list()
    assert.equal(devices.length, 3)
    assert.equal(devices.filter(device => device.current).length, 1)
    assert.ok(await clients[0].backup.request({ action: 'list' }))
    assert.ok(await clients[1].backup.request({ action: 'list' }), 'backup authentication accepts every active device')
    const transferId = randomUUID()
    await clients[2].backup.request({ action: 'receive', id: transferId, bytes: 1, sha256: 'a'.repeat(64) })
    await clients[0].devices!.revoke(devices.find(device => device.name === 'Device 2')!.id)
    await assert.rejects(clients[1].devices!.list(), { code: 'AUTH_REQUIRED' })
    assert.equal(clients[1].session().state, 'authInvalid')
    assert.equal((await clients[2].devices!.list()).length, 2, 'remaining device refreshes the fence automatically')
    assert.equal(clients[2].session().state, 'available')
    assert.equal((await clients[2].backup.request({ action: 'status', id: transferId })).jobs[0].id, transferId, 'another device revocation preserves transfer ownership')
    assert.equal((await clients[0].devices!.list()).length, 2)
    getDb().prepare('UPDATE catalog_identity SET catalog_id = ? WHERE id=1').run(randomUUID())
    assert.equal((await clients[0].reconnect()).state, 'available', 'server-bound device remains authorized after catalog restore')
    assert.equal((await clients[2].reconnect()).state, 'available')
    assert.equal((await clients[1].reconnect()).state, 'authInvalid', 'restore must not resurrect a revoked device')
  } finally {
    await Promise.all(clients.map(client => client.dispose()))
    await server.stop(); closeDatabase(); fs.rmSync(root, { recursive: true, force: true })
    if (previousRoot === undefined) delete process.env.JAVDEX_TEST_USER_DATA
    else process.env.JAVDEX_TEST_USER_DATA = previousRoot
  }
})
