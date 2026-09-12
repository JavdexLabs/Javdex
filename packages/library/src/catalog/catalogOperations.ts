import type Database from 'better-sqlite3'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { OperationReceipt, OperationReceiptStatus } from '@shared/protocol/operationReceipt'
import { structuredError } from '@shared/protocol/errors'
import { getDb } from '@library/db/database'
import { digestRequest } from './catalogSecrets'
import { readCatalogIdentity } from './catalogIdentity'

export interface CatalogMutationRequest {
  operationId: string
  operation: string
  expectedVersions: ExpectedVersions
  input: unknown
  writerEpoch: number
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
    if (duplicate) {
      return {
        outcome: 'duplicate' as const,
        receipt: duplicate.receipt,
        data: duplicate.row.result_json
          ? (JSON.parse(duplicate.row.result_json) as { data: T }).data
          : (undefined as unknown as T)
      }
    }
    const data = mutate()
    const createdAt = new Date().toISOString()
    const result = {
      entityIds: (data as { videoId?: number })?.videoId ? [(data as { videoId: number }).videoId] : undefined,
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
    const receipt: OperationReceipt = {
      operationId: request.operationId,
      status: 'applied',
      digest,
      entityIds: result.entityIds,
      versions: result.versions,
      createdAt
    }
    return { outcome: 'applied' as const, receipt, data }
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
    if (duplicate) {
      return {
        outcome: 'duplicate' as const,
        receipt: duplicate.receipt,
        data: duplicate.row.result_json
          ? (JSON.parse(duplicate.row.result_json) as { data: T }).data
          : (undefined as unknown as T)
      }
    }
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
