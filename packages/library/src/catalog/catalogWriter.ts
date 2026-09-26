import type Database from 'better-sqlite3'
import { CLAIM_CREDENTIAL_TTL_MS } from '@shared/protocol/limits'
import { structuredError } from '@shared/protocol/errors'
import type { WriterClaimKind, WriterClaimResult, WriterStatus } from '@shared/protocol/writer'
import { getDb } from '@library/db/database'
import { digestEquals, digestToken, generateSecret } from './catalogSecrets'
import { ensureCatalogIdentity, readCatalogIdentity, type CatalogIdentityState } from './catalogIdentity'
import { notifyPlayGrantsRevoked, revokeAllPlayGrants } from './catalogPlay'

const CLAIM_KINDS = new Set<WriterClaimKind>(['initialBind', 'handoff', 'deployRecover'])
const ASYNC_MAINTENANCE_KEYS = [
  'catalog-mutation-intent:%',
  'catalog-file-maintenance:%'
] as const

export interface IssuedOneTimeToken {
  kind: WriterClaimKind
  oneTimeToken: string
  expiresAt: string
  serverId: string
  catalogId: string
}

export interface WriterClaimRequest {
  kind: WriterClaimKind
  oneTimeToken: string
  candidate: { claimId: string; secretDigest: string }
}

interface TokenRow {
  token_digest: string
  kind: WriterClaimKind
  expires_at: string
  consumed_at: string | null
  claim_id: string | null
}

interface ClaimRow {
  claim_id: string
  kind: WriterClaimKind
  candidate_secret_digest: string
  status: WriterClaimResult['status'] | 'waitingMaintenance'
  writer_epoch: number | null
  result_json: string
}

function requireIdentity(database: Database.Database): CatalogIdentityState {
  const identity = readCatalogIdentity(database) ?? ensureCatalogIdentity({}, database)
  if (!identity.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '服务端实例尚未分配 serverId')
  }
  return identity
}

export function fileMaintenanceBlocksHandoff(database: Database.Database = getDb()): boolean {
  if (readCatalogIdentity(database)?.frozen) return true
  const scan = database
    .prepare(
      `SELECT 1 AS busy FROM library_scan_runs WHERE status IN ('queued', 'running') LIMIT 1`
    )
    .get() as { busy: number } | undefined
  if (scan) return true
  const task = database
    .prepare(
      `SELECT 1 AS busy FROM catalog_tasks
        WHERE state IN ('queued', 'running', 'cancelRequested')
        LIMIT 1`
    )
    .get() as { busy: number } | undefined
  if (task) return true
  const asyncMaintenance = database
    .prepare(
      `SELECT 1 AS busy FROM catalog_settings
        WHERE key LIKE ? OR key LIKE ?
        LIMIT 1`
    )
    .get(...ASYNC_MAINTENANCE_KEYS) as { busy: number } | undefined
  return Boolean(asyncMaintenance)
}


export function issueOneTimeToken(
  kind: WriterClaimKind,
  options: { now?: () => Date; token?: string } = {},
  database: Database.Database = getDb()
): IssuedOneTimeToken {
  if (!CLAIM_KINDS.has(kind)) throw structuredError('INVALID_INPUT', '未知的领取类型')
  if (options.token !== undefined && (options.token.length < 32 || options.token.length > 256)) {
    throw structuredError('INVALID_INPUT', '一次性凭据长度无效')
  }
  const now = options.now ?? (() => new Date())
  return database.transaction(() => {
    const identity = requireIdentity(database)
    if (kind === 'initialBind' && identity.writerEpoch > 0) {
      throw structuredError('AUTH_REQUIRED', '实例已认主，不能再次使用首次绑定命令')
    }
    if (kind !== 'initialBind' && identity.writerEpoch === 0) {
      throw structuredError('AUTH_REQUIRED', '实例尚未认主，请使用首次绑定命令')
    }
    const issuedAt = now()
    const expiresAt = new Date(issuedAt.getTime() + CLAIM_CREDENTIAL_TTL_MS).toISOString()
    const oneTimeToken = options.token ?? generateSecret()
    const tokenDigest = digestToken(oneTimeToken)
    database
      .prepare(
        `DELETE FROM catalog_one_time_tokens
         WHERE kind = ? AND consumed_at IS NULL`
      )
      .run(kind)
    database
      .prepare(
        `INSERT INTO catalog_one_time_tokens (
           token_digest, kind, expires_at, issued_at, consumed_at, claim_id
         ) VALUES (?, ?, ?, ?, NULL, NULL)`
      )
      .run(tokenDigest, kind, expiresAt, issuedAt.toISOString())
    if (!identity.serverId) throw structuredError('INSTANCE_MISMATCH', '服务端实例尚未分配 serverId')
    return {
      kind,
      oneTimeToken,
      expiresAt,
      serverId: identity.serverId,
      catalogId: identity.catalogId
    }
  })()
}

export function readWriterStatus(database: Database.Database = getDb()): WriterStatus {
  const identity = readCatalogIdentity(database)
  const maintenanceBusy = fileMaintenanceBlocksHandoff(database)
  const claim = database
    .prepare(
      `SELECT claim_id FROM catalog_writer_credentials
       WHERE superseded_at IS NULL
       ORDER BY writer_epoch DESC LIMIT 1`
    )
    .get() as { claim_id: string } | undefined
  return {
    writerEpoch: identity?.writerEpoch ?? 0,
    bound: Boolean(identity && identity.writerEpoch > 0),
    claimId: claim?.claim_id ?? null,
    maintenanceBusy
  }
}

export function readWriterClaim(
  claimId: string,
  database: Database.Database = getDb()
): WriterClaimResult | null {
  const row = database
    .prepare(
      `SELECT claim_id, kind, candidate_secret_digest, status, writer_epoch, result_json
       FROM catalog_writer_claims WHERE claim_id = ?`
    )
    .get(claimId) as ClaimRow | undefined
  if (!row || row.status === 'waitingMaintenance') return null
  return JSON.parse(row.result_json) as WriterClaimResult
}

function verifyWriterSecret(
  secret: string,
  database: Database.Database
): { epoch: number; claimId: string } | null {
  const digest = digestToken(secret)
  const row = database
    .prepare(
      `SELECT writer_epoch, secret_digest, claim_id
       FROM catalog_writer_credentials
       WHERE superseded_at IS NULL
       ORDER BY writer_epoch DESC LIMIT 1`
    )
    .get() as { writer_epoch: number; secret_digest: string; claim_id: string } | undefined
  if (!row || !digestEquals(row.secret_digest, digest)) return null
  return { epoch: row.writer_epoch, claimId: row.claim_id }
}

export function authenticateWriter(
  secret: string,
  expected: { serverId: string; catalogId: string; writerEpoch?: number },
  database: Database.Database = getDb()
): { identity: CatalogIdentityState; epoch: number; claimId: string } {
  const identity = readCatalogIdentity(database)
  if (!identity?.serverId) throw structuredError('AUTH_REQUIRED', '实例尚未认主')
  if (expected.serverId !== identity.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '目标实例已变化')
  }
  if (expected.catalogId !== identity.catalogId) {
    throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
  }
  if (identity.frozen) throw structuredError('CATALOG_FROZEN', '资料库已冻结')
  const writer = verifyWriterSecret(secret, database)
  if (!writer) throw structuredError('AUTH_REQUIRED', '管理凭据无效或已失效')
  if (expected.writerEpoch !== undefined && expected.writerEpoch !== writer.epoch) {
    throw structuredError('WRITER_REVOKED', '写入代次已变化')
  }
  return { identity, epoch: writer.epoch, claimId: writer.claimId }
}

export function claimWriter(
  input: WriterClaimRequest,
  options: { now?: () => Date } = {},
  database: Database.Database = getDb()
): WriterClaimResult {
  if (!CLAIM_KINDS.has(input.kind)) throw structuredError('INVALID_INPUT', '未知的领取类型')
  if (!/^[a-f0-9]{64}$/.test(input.candidate.secretDigest)) {
    throw structuredError('INVALID_INPUT', '候选凭据摘要无效', { field: 'candidate.secretDigest' })
  }
  const now = options.now ?? (() => new Date())
  let revoked: string[] = []
  const result = database.transaction(() => {
    const identity = requireIdentity(database)
    if (identity.frozen) throw structuredError('CATALOG_FROZEN', '资料库已冻结')
    const existing = database
      .prepare(
        `SELECT claim_id, kind, candidate_secret_digest, status, writer_epoch, result_json
         FROM catalog_writer_claims WHERE claim_id = ?`
      )
      .get(input.candidate.claimId) as ClaimRow | undefined
    if (existing) {
      if (!digestEquals(existing.candidate_secret_digest, input.candidate.secretDigest)) {
        throw structuredError('OPERATION_KEY_REUSED', '领取编号已被不同内容使用')
      }
      if (existing.status !== 'waitingMaintenance') {
        return JSON.parse(existing.result_json) as WriterClaimResult
      }
      database.prepare('DELETE FROM catalog_writer_claims WHERE claim_id = ?').run(existing.claim_id)
    }

    const tokenDigest = digestToken(input.oneTimeToken)
    const token = database
      .prepare(
        `SELECT token_digest, kind, expires_at, consumed_at, claim_id
         FROM catalog_one_time_tokens WHERE token_digest = ?`
      )
      .get(tokenDigest) as TokenRow | undefined
    if (!token || token.kind !== input.kind) {
      throw structuredError('AUTH_REQUIRED', '一次性凭据无效')
    }
    if (token.consumed_at) {
      throw structuredError('AUTH_REQUIRED', '一次性凭据已使用')
    }
    const at = now()
    if (Date.parse(token.expires_at) <= at.getTime()) {
      throw structuredError('AUTH_REQUIRED', '一次性凭据已过期')
    }
    if (input.kind === 'initialBind' && identity.writerEpoch > 0) {
      throw structuredError('AUTH_REQUIRED', '实例已认主')
    }
    if (input.kind !== 'initialBind' && identity.writerEpoch === 0) {
      throw structuredError('AUTH_REQUIRED', '实例尚未认主')
    }
    if (input.kind !== 'initialBind' && fileMaintenanceBlocksHandoff(database)) {
      throw structuredError('MAINTENANCE_BUSY', '当前有维护任务，请完成或取消任务后重新交接')
    }

    const nextEpoch = identity.writerEpoch + 1
    const createdAt = at.toISOString()
    database
      .prepare(
        `UPDATE catalog_writer_credentials
         SET superseded_at = ?
         WHERE superseded_at IS NULL`
      )
      .run(createdAt)
    database
      .prepare(
        `INSERT INTO catalog_writer_credentials (
           writer_epoch, secret_digest, claim_id, created_at, superseded_at
         ) VALUES (?, ?, ?, ?, NULL)`
      )
      .run(nextEpoch, input.candidate.secretDigest, input.candidate.claimId, createdAt)
    database
      .prepare(
        `UPDATE catalog_identity SET writer_epoch = ?, updated_at = ? WHERE id = 1`
      )
      .run(nextEpoch, createdAt)
    database
      .prepare(
        `UPDATE catalog_one_time_tokens
         SET consumed_at = ?, claim_id = ?
         WHERE token_digest = ?`
      )
      .run(createdAt, input.candidate.claimId, tokenDigest)
    const result: WriterClaimResult = {
      claimId: input.candidate.claimId,
      status: 'consumed',
      writerEpoch: nextEpoch,
      bound: true
    }
    database
      .prepare(
        `INSERT INTO catalog_writer_claims (
           claim_id, kind, candidate_secret_digest, status, writer_epoch, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'consumed', ?, ?, ?, ?)`
      )
      .run(
        input.candidate.claimId,
        input.kind,
        input.candidate.secretDigest,
        nextEpoch,
        JSON.stringify(result),
        createdAt,
        createdAt
      )
    revoked = revokeAllPlayGrants(database)
    return result
  })()
  notifyPlayGrantsRevoked(revoked)
  return result
}
