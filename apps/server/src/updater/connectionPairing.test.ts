import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ConnectionPairing } from './connectionPairing'

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
