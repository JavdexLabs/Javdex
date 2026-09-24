import type Database from 'better-sqlite3'
import { MIGRATION_AUTH_TTL_MS, MIGRATION_RECOVERY_TTL_MS } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { digestEquals, digestToken, generateSecret } from './catalogSecrets'
import { readCatalogIdentity, type CatalogIdentityState } from './catalogIdentity'
import { readCatalogSetting, writeCatalogSetting } from './catalogSettings'
import { MIGRATION_STATE_KEY } from './catalogMigrationState'

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
  /** Legacy recovery credentials may have a null expiry. */
  expiresAt: string | null
  createdAt: string
  migrationId?: string | null
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
    const issuedAt = now()
    const expiresAt = new Date(issuedAt.getTime() + MIGRATION_AUTH_TTL_MS).toISOString()
    const oneTimeToken = options.token ?? generateSecret()
    writeCatalogSetting(
      MIGRATION_AUTH_KEY,
      {
        tokenDigest: digestToken(oneTimeToken),
        kind: 'oneTime',
        expiresAt,
        createdAt: issuedAt.toISOString(),
        migrationId: null
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
  options: { now?: () => Date; migrationId?: string } = {}
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
    const checkedAt = now().getTime()
    const expiryTime = stored.expiresAt
      ? Date.parse(stored.expiresAt)
      : stored.kind === 'recovery'
        ? Date.parse(stored.createdAt) + MIGRATION_RECOVERY_TTL_MS
        : Number.NaN
    if (!Number.isFinite(expiryTime) || expiryTime <= checkedAt) {
      throw structuredError('AUTH_REQUIRED', '迁移凭据已过期，请在服务端重新签发')
    }
    const state = readCatalogSetting<{ migrationId: string; phase: string } | null>(MIGRATION_STATE_KEY, null, database)
    const boundMigrationId = stored.migrationId ?? (stored.kind === 'recovery' ? state?.migrationId : null)
    if (boundMigrationId && options.migrationId && boundMigrationId !== options.migrationId) {
      throw structuredError('AUTH_REQUIRED', '迁移凭据不属于此迁移，请在服务端重新签发')
    }
    if (!options.migrationId) {
      if (boundMigrationId && (state?.migrationId !== boundMigrationId || state.phase !== 'prepare')) {
        throw structuredError('AUTH_REQUIRED', '迁移凭据已绑定，不能预览另一迁移')
      }
    }
    const next: StoredMigrationAuth = {
      ...stored,
      kind: stored.kind === 'oneTime' && !options.migrationId ? 'oneTime' : 'recovery',
      expiresAt: stored.kind === 'oneTime' && options.migrationId
        ? new Date(checkedAt + MIGRATION_RECOVERY_TTL_MS).toISOString()
        : new Date(expiryTime).toISOString(),
      migrationId: boundMigrationId ?? options.migrationId ?? null
    }
    if (stored.kind !== next.kind || stored.expiresAt !== next.expiresAt || stored.migrationId !== next.migrationId) {
      writeCatalogSetting(MIGRATION_AUTH_KEY, next, database)
    }
    return identity
  })()
}
