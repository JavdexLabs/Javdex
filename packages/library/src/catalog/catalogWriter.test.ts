import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeDatabase, getDb, initDatabaseAtPath } from '@library/db/database'
import { isStructuredError } from '@shared/protocol/errors'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { MANAGE_PROTOCOL_VERSION } from '@shared/protocol/identity'
import { ensureCatalogIdentity, isWriterBound, readCatalogIdentity, setCatalogFrozen } from './catalogIdentity'
import { readHandshake } from './catalogHandshake'
import {
  authenticateWriter,
  claimWriter,
  issueOneTimeToken,
  readWriterClaim,
  readWriterStatus
} from './catalogWriter'
import { digestToken, generateSecret } from './catalogSecrets'

let root: string | null = null

function setup(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-s05-writer-'))
  initDatabaseAtPath(path.join(root, 'library.db'))
}

afterEach(() => {
  closeDatabase()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('catalog writer protocol', () => {
  it('issues a one-time bind token, claims once, and retries the same claim without a second epoch', () => {
    setup()
    const identity = ensureCatalogIdentity({ serverId: randomUUID() })
    assert.equal(isWriterBound(), false)
    assert.equal(identity.writerEpoch, 0)
    const issued = issueOneTimeToken('initialBind')
    assert.equal(issued.serverId, identity.serverId)
    assert.equal(issued.catalogId, identity.catalogId)
    assert.doesNotMatch(issued.oneTimeToken, /[\n\r]/)
    const candidate = { claimId: randomUUID(), secretDigest: digestToken(generateSecret()) }
    const first = claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate
    })
    assert.equal(first.status, 'consumed')
    assert.equal(first.writerEpoch, 1)
    assert.equal(isWriterBound(), true)
    const again = claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate
    })
    assert.deepEqual(again, first)
    assert.equal(readCatalogIdentity()?.writerEpoch, 1)
    assert.equal(readWriterStatus().bound, true)
    assert.equal(readWriterClaim(candidate.claimId)?.status, 'consumed')
  })

  it('rejects a reused claim id with a different candidate digest', () => {
    setup()
    ensureCatalogIdentity({ serverId: randomUUID() })
    const issued = issueOneTimeToken('initialBind')
    const claimId = randomUUID()
    claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate: { claimId, secretDigest: digestToken(generateSecret()) }
    })
    assert.throws(
      () =>
        claimWriter({
          kind: 'initialBind',
          oneTimeToken: issued.oneTimeToken,
          candidate: { claimId, secretDigest: digestToken(generateSecret()) }
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'OPERATION_KEY_REUSED'
    )
  })

  it('waits for file maintenance before consuming a handoff token, then switches epoch', () => {
    setup()
    const serverId = randomUUID()
    ensureCatalogIdentity({ serverId })
    const bind = issueOneTimeToken('initialBind')
    const firstSecret = generateSecret()
    const firstClaim = randomUUID()
    claimWriter({
      kind: 'initialBind',
      oneTimeToken: bind.oneTimeToken,
      candidate: { claimId: firstClaim, secretDigest: digestToken(firstSecret) }
    })
    getDb()
      .prepare(
        `INSERT INTO library_scan_runs (
           id, library_id, config_revision, trigger, status, started_at
         ) VALUES (?, 1, 1, 'manual', 'running', ?)`
      )
      .run('blocking-scan', '2026-09-12T00:00:00.000Z')
    const handoff = issueOneTimeToken('handoff')
    const nextSecret = generateSecret()
    const nextClaim = randomUUID()
    const waiting = claimWriter({
      kind: 'handoff',
      oneTimeToken: handoff.oneTimeToken,
      candidate: { claimId: nextClaim, secretDigest: digestToken(nextSecret) }
    })
    assert.equal(waiting.status, 'waitingMaintenance')
    assert.equal(readCatalogIdentity()?.writerEpoch, 1)
    assert.throws(
      () => issueOneTimeToken('handoff'),
      (error: unknown) => isStructuredError(error) && error.code === 'MAINTENANCE_BUSY'
    )
    authenticateWriter(firstSecret, { serverId, catalogId: readCatalogIdentity()!.catalogId, writerEpoch: 1 })
    getDb().prepare("UPDATE library_scan_runs SET status = 'completed' WHERE id = 'blocking-scan'").run()
    const consumed = claimWriter({
      kind: 'handoff',
      oneTimeToken: handoff.oneTimeToken,
      candidate: { claimId: nextClaim, secretDigest: digestToken(nextSecret) }
    })
    assert.equal(consumed.status, 'consumed')
    assert.equal(consumed.writerEpoch, 2)
    assert.throws(
      () => authenticateWriter(firstSecret, { serverId, catalogId: readCatalogIdentity()!.catalogId, writerEpoch: 1 }),
      (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'
    )
    authenticateWriter(nextSecret, { serverId, catalogId: readCatalogIdentity()!.catalogId, writerEpoch: 2 })
  })

  it('rejects claim and writer auth while the catalog is frozen', () => {
    setup()
    const serverId = randomUUID()
    ensureCatalogIdentity({ serverId })
    const issued = issueOneTimeToken('initialBind')
    const secret = generateSecret()
    claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate: { claimId: randomUUID(), secretDigest: digestToken(secret) }
    })
    setCatalogFrozen(true)
    assert.throws(
      () =>
        authenticateWriter(secret, {
          serverId,
          catalogId: readCatalogIdentity()!.catalogId,
          writerEpoch: 1
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'CATALOG_FROZEN'
    )
    const handoff = issueOneTimeToken('handoff')
    assert.throws(
      () =>
        claimWriter({
          kind: 'handoff',
          oneTimeToken: handoff.oneTimeToken,
          candidate: { claimId: randomUUID(), secretDigest: digestToken(generateSecret()) }
        }),
      (error: unknown) => isStructuredError(error) && error.code === 'CATALOG_FROZEN'
    )
  })

  it('ignores bootstrap after the instance is already bound', () => {
    setup()
    ensureCatalogIdentity({ serverId: randomUUID() })
    const issued = issueOneTimeToken('initialBind')
    claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate: { claimId: randomUUID(), secretDigest: digestToken(generateSecret()) }
    })
    assert.throws(
      () => issueOneTimeToken('initialBind'),
      (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'
    )
  })

  it('returns identity on handshake before bind and marks ready after claim', () => {
    setup()
    const serverId = randomUUID()
    ensureCatalogIdentity({ serverId })
    const unbound = readHandshake({ appVersion: '0.7.0', browserEnabled: true })
    assert.equal(unbound.ready, 'notBound')
    assert.equal(unbound.identity.serverId, serverId)
    assert.equal(unbound.writerEpoch, 0)
    assert.equal(unbound.protocolVersion, MANAGE_PROTOCOL_VERSION)
    assert.equal(unbound.schemaVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(unbound.capabilities.encryptedAssets, false)
    const issued = issueOneTimeToken('initialBind')
    claimWriter({
      kind: 'initialBind',
      oneTimeToken: issued.oneTimeToken,
      candidate: { claimId: randomUUID(), secretDigest: digestToken(generateSecret()) }
    })
    const bound = readHandshake({ appVersion: '0.7.0', browserEnabled: true })
    assert.equal(bound.ready, 'ready')
    assert.equal(bound.writerEpoch, 1)
    assert.equal(bound.capabilities.writerBound, true)
  })
})
