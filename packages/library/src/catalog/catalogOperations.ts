import type Database from 'better-sqlite3'
import fs from 'node:fs'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { OperationReceipt, OperationReceiptStatus } from '@shared/protocol/operationReceipt'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { digestRequest } from './catalogSecrets'
import { readCatalogIdentity } from './catalogIdentity'
import { deleteCatalogSetting, readCatalogSetting, writeCatalogSetting } from './catalogSettings'

export interface CatalogMutationRequest {
  operationId: string
  operation: string
  expectedVersions: ExpectedVersions
  input: unknown
  writerEpoch: number
}

export interface CatalogWriteContext {
  operationId: string
  expectedVersions: ExpectedVersions
  writerEpoch: number
  database?: Database.Database
}

interface ReceiptRow {
  operation_id: string
  request_digest: string
  operation: string
  status: 'applied' | 'rejected' | 'acceptedTask'
  writer_epoch: number
  result_json: string | null
  error_code: string | null
  created_at: string
}

/**
 * A mutation which has passed the writer/version gate but still has an
 * asynchronous side effect to finish.  The setting is deliberately kept in
 * the catalog so a process restart cannot turn an accepted operation into a
 * client-visible "unknown" operation.
 */
const MUTATION_INTENT_PREFIX = 'catalog-mutation-intent:'

interface CatalogMutationIntent {
  operationId: string
  requestDigest: string
  operation: string
  writerEpoch: number
  createdAt: string
}

export type DuplicateMutationResult<T> = {
  outcome: 'duplicate'
  receipt: OperationReceipt
  data: T
}

function mutationIntentKey(operationId: string): string {
  return `${MUTATION_INTENT_PREFIX}${operationId}`
}

function toReceipt(row: ReceiptRow, status: OperationReceiptStatus): OperationReceipt {
  const parsed = row.result_json ? (JSON.parse(row.result_json) as Partial<OperationReceipt>) : {}
  return {
    operationId: row.operation_id,
    status,
    digest: row.request_digest,
    entityIds: parsed.entityIds,
    counts: parsed.counts,
    versions: parsed.versions,
    errorCode: row.error_code ?? parsed.errorCode,
    taskId: parsed.taskId,
    createdAt: row.created_at
  }
}

export function digestCatalogMutation(request: Omit<CatalogMutationRequest, 'operationId' | 'writerEpoch'>): string {
  return digestRequest({
    operation: request.operation,
    expectedVersions: request.expectedVersions,
    input: request.input
  })
}

/** Test-only: pause inside the open SQLite transaction so a test can SIGKILL before commit. */
function stallBeforeCommitForTests(): void {
  const instructionPath = process.env.JAVDEX_TEST_STALL_BEFORE_COMMIT
  if (!instructionPath || !fs.existsSync(instructionPath)) return
  try {
    fs.unlinkSync(instructionPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  fs.writeFileSync(`${instructionPath}.ready`, '1')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (fs.existsSync(`${instructionPath}.done`)) return
    const slice = Date.now() + 20
    while (Date.now() < slice) {
      // Keep the SQLite transaction open until the test SIGKILLs this process.
    }
  }
  throw new Error('JAVDEX_TEST_STALL_BEFORE_COMMIT timed out inside the mutation transaction')
}

export function readOperationReceipt(
  operationId: string,
  database: Database.Database = getDb()
): OperationReceipt | null {
  const row = database
    .prepare(
      `SELECT operation_id, request_digest, operation, status, writer_epoch, result_json, error_code, created_at
       FROM catalog_operation_receipts WHERE operation_id = ?`
    )
    .get(operationId) as ReceiptRow | undefined
  if (!row) return null
  return toReceipt(row, row.status === 'applied' ? 'applied' : row.status === 'acceptedTask' ? 'acceptedTask' : 'rejected')
}

function existingReceipt(
  request: CatalogMutationRequest,
  digest: string,
  database: Database.Database
): { row: ReceiptRow; receipt: OperationReceipt } | null {
  const existing = database
    .prepare(
      `SELECT operation_id, request_digest, operation, status, writer_epoch, result_json, error_code, created_at
       FROM catalog_operation_receipts WHERE operation_id = ?`
    )
    .get(request.operationId) as ReceiptRow | undefined
  if (!existing) return null
  if (existing.request_digest !== digest) {
    throw structuredError(
      'OPERATION_KEY_REUSED',
      '操作编号已被不同内容使用',
      undefined,
      request.operationId
    )
  }
  return { row: existing, receipt: toReceipt(existing, 'duplicate') }
}

/**
 * Read a previously completed mutation without re-running its domain
 * preparation.  This matters for retryable workflows whose source row is
 * deleted by the first successful attempt.
 */
export function readCatalogMutation<T>(
  request: CatalogMutationRequest,
  database: Database.Database = getDb()
): DuplicateMutationResult<T> | null {
  const digest = digestCatalogMutation(request)
  const duplicate = existingReceipt(request, digest, database)
  return duplicate ? duplicateResult<T>(duplicate) : null
}

function duplicateResult<T>(
  duplicate: { row: ReceiptRow; receipt: OperationReceipt }
): DuplicateMutationResult<T> {
  return {
    outcome: 'duplicate',
    receipt: duplicate.receipt,
    data: duplicate.row.result_json
      ? (JSON.parse(duplicate.row.result_json) as { data: T }).data
      : (undefined as unknown as T)
  }
}

function mutationResult<T>(
  request: CatalogMutationRequest,
  digest: string,
  data: T,
  database: Database.Database
): { outcome: 'applied'; receipt: OperationReceipt; data: T } {
  const createdAt = new Date().toISOString()
  const result = {
    entityIds: (data as { videoId?: number })?.videoId
      ? [(data as { videoId: number }).videoId]
      : undefined,
    versions: (data as { versions?: ExpectedVersions }).versions,
    data
  }
  database
    .prepare(
      `INSERT INTO catalog_operation_receipts (
         operation_id, request_digest, operation, status, writer_epoch, result_json, error_code, created_at
       ) VALUES (?, ?, ?, 'applied', ?, ?, NULL, ?)`
    )
    .run(
      request.operationId,
      digest,
      request.operation,
      request.writerEpoch,
      JSON.stringify(result),
      createdAt
    )
  return {
    outcome: 'applied',
    receipt: {
      operationId: request.operationId,
      status: 'applied',
      digest,
      entityIds: result.entityIds,
      versions: result.versions,
      createdAt
    },
    data
  }
}

function assertMutationGate(request: CatalogMutationRequest, database: Database.Database): void {
  const identity = readCatalogIdentity(database)
  if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化', undefined, request.operationId)
  if (identity.frozen) {
    throw structuredError('CATALOG_FROZEN', '资料库已冻结', { operationId: request.operationId }, request.operationId)
  }
  if (identity.writerEpoch !== request.writerEpoch) {
    throw structuredError('WRITER_REVOKED', '写入代次已变化', undefined, request.operationId)
  }
}

/** Reserve an operation before an asynchronous side effect starts. */
export function beginCatalogMutation(
  request: CatalogMutationRequest,
  database: Database.Database = getDb()
): { outcome: 'prepared'; digest: string } | DuplicateMutationResult<never> {
  const digest = digestCatalogMutation(request)
  return database.transaction(() => {
    assertMutationGate(request, database)
    const duplicate = existingReceipt(request, digest, database)
    if (duplicate) return duplicateResult<never>(duplicate)
    const existing = readCatalogSetting<CatalogMutationIntent | null>(
      mutationIntentKey(request.operationId),
      null,
      database
    )
    if (existing) {
      if (
        existing.requestDigest !== digest ||
        existing.operation !== request.operation ||
        existing.writerEpoch !== request.writerEpoch
      ) {
        throw structuredError(
          'OPERATION_KEY_REUSED',
          '操作编号已被不同内容使用',
          undefined,
          request.operationId
        )
      }
      return { outcome: 'prepared' as const, digest }
    }
    writeCatalogSetting(
      mutationIntentKey(request.operationId),
      {
        operationId: request.operationId,
        requestDigest: digest,
        operation: request.operation,
        writerEpoch: request.writerEpoch,
        createdAt: new Date().toISOString()
      } satisfies CatalogMutationIntent,
      database
    )
    return { outcome: 'prepared' as const, digest }
  })()
}

/** Finish a previously reserved operation and atomically create its receipt. */
export function completeCatalogMutation<T>(
  request: CatalogMutationRequest,
  data: T,
  database: Database.Database = getDb()
): { outcome: 'applied' | 'duplicate'; receipt: OperationReceipt; data: T } {
  const digest = digestCatalogMutation(request)
  return database.transaction(() => {
    const duplicate = existingReceipt(request, digest, database)
    if (duplicate) return duplicateResult<T>(duplicate)
    const intent = readCatalogSetting<CatalogMutationIntent | null>(
      mutationIntentKey(request.operationId),
      null,
      database
    )
    if (
      !intent ||
      intent.requestDigest !== digest ||
      intent.operation !== request.operation ||
      intent.writerEpoch !== request.writerEpoch
    ) {
      throw structuredError(
        'RECOVERY_REQUIRED',
        '异步写入缺少可恢复操作意图',
        { operationId: request.operationId },
        request.operationId
      )
    }
    // The physical side effect may have crossed a process boundary. Keep the
    // final receipt commit subject to the same writer/freeze gate as begin so
    // a revoked writer cannot finish an old request after a handoff.
    assertMutationGate(request, database)
    const result = mutationResult(request, digest, data, database)
    deleteCatalogSetting(mutationIntentKey(request.operationId), database)
    return result
  })()
}

export function abortCatalogMutation(
  request: CatalogMutationRequest,
  database: Database.Database = getDb()
): void {
  const digest = digestCatalogMutation(request)
  database.transaction(() => {
    const intent = readCatalogSetting<CatalogMutationIntent | null>(
      mutationIntentKey(request.operationId),
      null,
      database
    )
    if (intent?.requestDigest === digest) deleteCatalogSetting(mutationIntentKey(request.operationId), database)
  })()
}

/** Remove a reserved async mutation after startup proves it had no side effect. */
export function clearCatalogMutationIntent(
  operationId: string,
  database: Database.Database = getDb()
): void {
  deleteCatalogSetting(mutationIntentKey(operationId), database)
}

export function readCatalogMutationIntent(
  operationId: string,
  database: Database.Database = getDb()
): { operation: string; writerEpoch: number } | null {
  const intent = readCatalogSetting<CatalogMutationIntent | null>(
    mutationIntentKey(operationId),
    null,
    database
  )
  return intent
    ? { operation: intent.operation, writerEpoch: intent.writerEpoch }
    : null
}

export function listCatalogMutationIntentOperationIds(database: Database.Database = getDb()): string[] {
  return database
    .prepare('SELECT key FROM catalog_settings WHERE key LIKE ?')
    .all(`${MUTATION_INTENT_PREFIX}%`)
    .map((row) => String((row as { key: string }).key).slice(MUTATION_INTENT_PREFIX.length))
}

export function commitCatalogMutation<T>(
  request: CatalogMutationRequest,
  mutate: () => T,
  database: Database.Database = getDb()
): { outcome: 'applied' | 'duplicate'; receipt: OperationReceipt; data: T } {
  const digest = digestCatalogMutation(request)
  return database.transaction(() => {
    const identity = readCatalogIdentity(database)
    if (!identity) throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化', undefined, request.operationId)
    if (identity.frozen) {
      throw structuredError('CATALOG_FROZEN', '资料库已冻结', { operationId: request.operationId }, request.operationId)
    }
    if (identity.writerEpoch !== request.writerEpoch) {
      throw structuredError('WRITER_REVOKED', '写入代次已变化', undefined, request.operationId)
    }
    const duplicate = existingReceipt(request, digest, database)
    if (duplicate) return duplicateResult<T>(duplicate)
    const data = mutate()
    const result = mutationResult(request, digest, data, database)
    stallBeforeCommitForTests()
    return result
  })()
}

export function acceptCatalogTask<T extends { taskId: string }>(
  request: CatalogMutationRequest,
  enqueue: () => T,
  database: Database.Database = getDb()
): { outcome: 'applied' | 'duplicate'; receipt: OperationReceipt; data: T } {
  const digest = digestCatalogMutation(request)
  return database.transaction(() => {
    const identity = readCatalogIdentity(database)
    if (!identity) {
      throw structuredError('AUTH_REQUIRED', '资料库身份尚未初始化', undefined, request.operationId)
    }
    if (identity.frozen) {
      throw structuredError(
        'CATALOG_FROZEN',
        '资料库已冻结',
        { operationId: request.operationId },
        request.operationId
      )
    }
    if (identity.writerEpoch !== request.writerEpoch) {
      throw structuredError('WRITER_REVOKED', '写入代次已变化', undefined, request.operationId)
    }
    const duplicate = existingReceipt(request, digest, database)
    if (duplicate) return duplicateResult<T>(duplicate)
    const data = enqueue()
    const createdAt = new Date().toISOString()
    const result = { taskId: data.taskId, data }
    database
      .prepare(
        `INSERT INTO catalog_operation_receipts (
           operation_id, request_digest, operation, status, writer_epoch, result_json, error_code, created_at
         ) VALUES (?, ?, ?, 'acceptedTask', ?, ?, NULL, ?)`
      )
      .run(
        request.operationId,
        digest,
        request.operation,
        request.writerEpoch,
        JSON.stringify(result),
        createdAt
      )
    const receipt: OperationReceipt = {
      operationId: request.operationId,
      status: 'acceptedTask',
      digest,
      taskId: data.taskId,
      createdAt
    }
    return { outcome: 'applied' as const, receipt, data }
  })()
}
