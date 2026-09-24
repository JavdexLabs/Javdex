import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MIGRATION_AUTH_TTL_MS, MIGRATION_RECOVERY_TTL_MS } from '@shared/protocol/limits'
import { isStructuredError } from '@shared/protocol/errors'
import { ensureCatalogIdentity } from './catalogIdentity'
import { openIsolatedCatalog } from './catalogMigration'
import { readCatalogSetting, writeCatalogSetting } from './catalogSettings'
import { MIGRATION_STATE_KEY } from './catalogMigrationState'
import { authenticateMigration, issueCatalogMigrationToken, MIGRATION_AUTH_KEY } from './catalogMigrationAuth'

describe('migration credential lifetime', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function database() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-migration-auth-'))
    roots.push(root)
    const db = openIsolatedCatalog(path.join(root, 'library.db'))
    ensureCatalogIdentity({ serverId: randomUUID() }, db)
    return db
  }

  const at = (millis: number) => () => new Date(millis)
  const denied = (error: unknown) => isStructuredError(error) && error.code === 'AUTH_REQUIRED'

  it('expires an unused issue token and lets the local CLI replace it', () => {
    const db = database()
    try {
      const issued = issueCatalogMigrationToken({ now: at(0) }, db)
      assert.equal(Date.parse(issued.expiresAt), MIGRATION_AUTH_TTL_MS)
      authenticateMigration(issued.oneTimeToken, db, { now: at(MIGRATION_AUTH_TTL_MS - 1) })
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, { now: at(MIGRATION_AUTH_TTL_MS) }), denied)
      const replacement = issueCatalogMigrationToken({ now: at(MIGRATION_AUTH_TTL_MS) }, db)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, { now: at(MIGRATION_AUTH_TTL_MS) }), denied)
      authenticateMigration(replacement.oneTimeToken, db, { now: at(MIGRATION_AUTH_TTL_MS) })
    } finally {
      db.close()
    }
  })

  it('expires a claimed credential and rotates it without keeping the old bearer valid', () => {
    const db = database()
    try {
      const issued = issueCatalogMigrationToken({ now: at(0) }, db)
      const migrationId = randomUUID()
      authenticateMigration(issued.oneTimeToken, db, { now: at(1_000), migrationId })
      authenticateMigration(issued.oneTimeToken, db, { now: at(1_000 + MIGRATION_RECOVERY_TTL_MS - 1), migrationId })
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, {
        now: at(1_000 + MIGRATION_RECOVERY_TTL_MS), migrationId
      }), denied)
      const rotated = issueCatalogMigrationToken({ now: at(2_000) }, db)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, { now: at(2_000) }), denied)
      authenticateMigration(rotated.oneTimeToken, db, { now: at(2_000) })
    } finally {
      db.close()
    }
  })

  it('bounds legacy recovery credentials from their original issue time', () => {
    const db = database()
    try {
      const issued = issueCatalogMigrationToken({ now: at(0) }, db)
      const migrationId = randomUUID()
      authenticateMigration(issued.oneTimeToken, db, { now: at(1_000), migrationId })
      const stored = readCatalogSetting<{ tokenDigest: string; kind: 'recovery'; expiresAt: string | null; createdAt: string } | null>(MIGRATION_AUTH_KEY, null, db)!
      writeCatalogSetting(MIGRATION_AUTH_KEY, { ...stored, expiresAt: null }, db)
      authenticateMigration(issued.oneTimeToken, db, { now: at(MIGRATION_RECOVERY_TTL_MS - 1), migrationId })
      assert.equal(Date.parse(readCatalogSetting<{ expiresAt: string } | null>(MIGRATION_AUTH_KEY, null, db)!.expiresAt), MIGRATION_RECOVERY_TTL_MS)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, {
        now: at(MIGRATION_RECOVERY_TTL_MS), migrationId
      }), denied)
    } finally {
      db.close()
    }
  })

  it('binds an old unscoped recovery credential to its existing migration state', () => {
    const db = database()
    try {
      const issued = issueCatalogMigrationToken({ now: at(0) }, db)
      const migrationId = randomUUID()
      authenticateMigration(issued.oneTimeToken, db, { now: at(1_000), migrationId })
      const stored = readCatalogSetting<Record<string, unknown> | null>(MIGRATION_AUTH_KEY, null, db)!
      delete stored.migrationId
      writeCatalogSetting(MIGRATION_AUTH_KEY, stored, db)
      writeCatalogSetting(MIGRATION_STATE_KEY, { migrationId, phase: 'frozen' }, db)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, {
        now: at(2_000), migrationId: randomUUID()
      }), denied)
      authenticateMigration(issued.oneTimeToken, db, { now: at(2_000), migrationId })
      assert.equal(readCatalogSetting<{ migrationId: string } | null>(MIGRATION_AUTH_KEY, null, db)?.migrationId,
        migrationId)
    } finally {
      db.close()
    }
  })

  it('binds a claimed token to one migration while allowing a retry of its source preview', () => {
    const db = database()
    try {
      const issued = issueCatalogMigrationToken({ now: at(0) }, db)
      const migrationId = randomUUID()
      authenticateMigration(issued.oneTimeToken, db, { now: at(1_000), migrationId })
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, {
        now: at(2_000), migrationId: randomUUID()
      }), denied)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, { now: at(2_000) }), denied)
      writeCatalogSetting(MIGRATION_STATE_KEY, { migrationId, phase: 'prepare' }, db)
      authenticateMigration(issued.oneTimeToken, db, { now: at(2_000) })
      writeCatalogSetting(MIGRATION_STATE_KEY, { migrationId, phase: 'enabled' }, db)
      assert.throws(() => authenticateMigration(issued.oneTimeToken, db, { now: at(3_000) }), denied)
      authenticateMigration(issued.oneTimeToken, db, { now: at(3_000), migrationId })
    } finally {
      db.close()
    }
  })
})
