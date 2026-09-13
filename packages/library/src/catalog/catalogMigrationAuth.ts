import type Database from 'better-sqlite3'
import { CLAIM_CREDENTIAL_TTL_MS } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { digestEquals, digestToken, generateSecret } from './catalogSecrets'
import { readCatalogIdentity, type CatalogIdentityState } from './catalogIdentity'
import { readCatalogSetting, writeCatalogSetting } from './catalogSettings'

export const MIGRATION_AUTH_KEY = 'migration-auth'

export interface IssuedMigrationToken {
  oneTimeToken: string
  expiresAt: string
  serverId: string
  catalogId: string
}

interface StoredMigrationAuth {
  tokenDigest: string
  kind: 'oneTime' | 'recovery'
  expiresAt: string | null
  createdAt: string
}

function requireIdentity(database: Database.Database): CatalogIdentityState {
  const identity = readCatalogIdentity(database)
  if (!identity?.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '服务端实例尚未分配 serverId')
  }
  return identity
}

export function issueCatalogMigrationToken(
  options: { now?: () => Date; token?: string } = {},
  database: Database.Database = getDb()
): IssuedMigrationToken {
  const now = options.now ?? (() => new Date())
  return database.transaction(() => {
    const identity = requireIdentity(database)
    if (options.token !== undefined && (options.token.length < 32 || options.token.length > 256)) {
      throw structuredError('INVALID_INPUT', '一次性凭据长度无效')
    }
    const existing = readCatalogSetting<StoredMigrationAuth | null>(MIGRATION_AUTH_KEY, null, database)
    if (existing?.kind === 'recovery') {
      throw structuredError('AUTH_REQUIRED', '该空目标已有进行中的迁移恢复凭据')
    }
    const issuedAt = now()
    const expiresAt = new Date(issuedAt.getTime() + CLAIM_CREDENTIAL_TTL_MS).toISOString()
    const oneTimeToken = options.token ?? generateSecret()
    writeCatalogSetting(
      MIGRATION_AUTH_KEY,
      {
        tokenDigest: digestToken(oneTimeToken),
        kind: 'oneTime',
        expiresAt,
        createdAt: issuedAt.toISOString()
      } satisfies StoredMigrationAuth,
      database
    )
    return {
      oneTimeToken,
      expiresAt,
      serverId: identity.serverId!,
      catalogId: identity.catalogId
    }
  })()
}

export function authenticateMigration(
  secret: string | null,
  database: Database.Database = getDb(),
  options: { now?: () => Date } = {}
): CatalogIdentityState {
  if (!secret) throw structuredError('AUTH_REQUIRED', '需要迁移凭据')
  const now = options.now ?? (() => new Date())
  return database.transaction(() => {
    const identity = requireIdentity(database)
    const stored = readCatalogSetting<StoredMigrationAuth | null>(MIGRATION_AUTH_KEY, null, database)
    if (!stored) throw structuredError('AUTH_REQUIRED', '迁移凭据无效或已失效')
    if (!digestEquals(stored.tokenDigest, digestToken(secret))) {
      throw structuredError('AUTH_REQUIRED', '迁移凭据无效或已失效')
    }
    if (stored.kind === 'oneTime') {
      if (!stored.expiresAt || Date.parse(stored.expiresAt) <= now().getTime()) {
        throw structuredError('AUTH_REQUIRED', '一次性迁移凭据已过期')
      }
      writeCatalogSetting(
        MIGRATION_AUTH_KEY,
        {
          tokenDigest: stored.tokenDigest,
          kind: 'recovery',
          expiresAt: null,
          createdAt: stored.createdAt
        } satisfies StoredMigrationAuth,
        database
      )
    }
    return identity
  })()
}
