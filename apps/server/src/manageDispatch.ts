import type Database from 'better-sqlite3'
import { scopedVideoCatalogRepo } from '@library/db/scopedVideoCatalogRepo'
import { videoMaintenanceService } from '@library/catalog/videoMaintenanceService'
import { videoEditInputFromManageFields } from '@library/catalog/videoEditFields'
import { readHandshake } from '@library/catalog/catalogHandshake'
import { readCatalogIdentity } from '@library/catalog/catalogIdentity'
import {
  authenticateWriter,
  claimWriter,
  issueOneTimeToken,
  readWriterClaim,
  readWriterStatus,
  type WriterClaimRequest
} from '@library/catalog/catalogWriter'
import { commitCatalogMutation, readOperationReceipt } from '@library/catalog/catalogOperations'
import {
  assertExpectedVideoVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogVideoVersion'
import { MANAGE_OPERATIONS, type ManageOperationId } from '@shared/manage/operations'
import { parseManageRequest } from '@shared/manage/parse'
import type { ManageHttpContext } from '@http/manage'
import { structuredError } from '@shared/protocol/errors'
import type { OperationReceipt } from '@shared/protocol/operationReceipt'
import type { ExpectedVersions } from '@shared/protocol/versions'
import { SERVER_APP_VERSION } from './appVersion'

interface ManageEnvelope {
  serverId?: string
  catalogId?: string
  writerEpoch?: number
  operationId?: string
  expectedVersions?: ExpectedVersions
  input: unknown
}

function requireIdentity() {
  const identity = readCatalogIdentity()
  if (!identity?.serverId) {
    throw structuredError('INSTANCE_MISMATCH', '服务端实例尚未分配 serverId')
  }
  return identity
}

function requireBearer(
  context: ManageHttpContext,
  expected: { serverId: string; catalogId: string; writerEpoch?: number }
) {
  if (!context.bearerSecret) {
    throw structuredError('AUTH_REQUIRED', '需要管理凭据')
  }
  return authenticateWriter(context.bearerSecret, expected)
}

function parseEnvelope(operation: ManageOperationId, body: unknown): ManageEnvelope {
  const parsed = parseManageRequest(operation, body)
  if (!parsed.success) {
    throw structuredError('INVALID_INPUT', '请求格式无效')
  }
  return parsed.data as ManageEnvelope
}

function unknownReceipt(operationId: string): OperationReceipt {
  return {
    operationId,
    status: 'unknown',
    digest: '',
    createdAt: ''
  }
}

export function dispatchManageOperation(context: ManageHttpContext, database?: Database.Database): unknown {
  const operation = context.operation
  const meta = MANAGE_OPERATIONS[operation]
  if (operation === 'handshake.get') {
    parseEnvelope('handshake.get', context.body)
    return readHandshake({ appVersion: SERVER_APP_VERSION, browserEnabled: true }, database)
  }
  if (operation === 'writer.claim') {
    const parsed = parseEnvelope('writer.claim', context.body)
    const identity = requireIdentity()
    if (parsed.serverId !== identity.serverId) {
      throw structuredError('INSTANCE_MISMATCH', '目标实例已变化')
    }
    if (parsed.catalogId !== identity.catalogId) {
      throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
    }
    return claimWriter(parsed.input as WriterClaimRequest, {}, database)
  }
  if (operation === 'writer.claimStatus') {
    const parsed = parseEnvelope('writer.claimStatus', context.body)
    const identity = requireIdentity()
    if (parsed.serverId && parsed.serverId !== identity.serverId) {
      throw structuredError('INSTANCE_MISMATCH', '目标实例已变化')
    }
    if (parsed.catalogId && parsed.catalogId !== identity.catalogId) {
      throw structuredError('CATALOG_MISMATCH', '目标资料库已变化')
    }
    const claim = readWriterClaim((parsed.input as { claimId: string }).claimId, database)
    if (!claim) throw structuredError('INVALID_INPUT', '领取记录不存在')
    return claim
  }
  if (operation === 'writer.recoverIssue') {
    parseEnvelope('writer.recoverIssue', context.body)
    if (!context.isLoopback) {
      throw structuredError('AUTH_REQUIRED', '部署恢复令牌只能在本机环回接口签发')
    }
    return issueOneTimeToken('deployRecover', {}, database)
  }
  if (meta.auth === 'migration' || meta.auth === 'publicHandshake') {
    throw structuredError('UNSUPPORTED_CAPABILITY', `S05 尚未实现 ${operation}`)
  }

  if (meta.auth === 'manageRead' || meta.auth === 'manageWrite') {
    const envelope = parseEnvelope(operation, context.body)
    if (!envelope.serverId || !envelope.catalogId) {
      throw structuredError('INVALID_INPUT', '请求格式无效')
    }
    const auth = requireBearer(context, {
      serverId: envelope.serverId,
      catalogId: envelope.catalogId,
      writerEpoch: envelope.writerEpoch
    })
    if (operation === 'writer.status') return readWriterStatus(database)
    if (operation === 'writer.handoffBegin') {
      return issueOneTimeToken('handoff', {}, database)
    }
    if (operation === 'operations.get') {
      const input = envelope.input as { operationId: string }
      return readOperationReceipt(input.operationId, database) ?? unknownReceipt(input.operationId)
    }
    if (operation === 'videos.get') {
      const input = envelope.input as {
        scope: Parameters<typeof scopedVideoCatalogRepo.get>[0]
        videoId: number
      }
      return scopedVideoCatalogRepo.get(input.scope, input.videoId)
    }
    if (operation === 'videos.edit') {
      const input = envelope.input as {
        videoId: number
        fields: Parameters<typeof videoEditInputFromManageFields>[0]
      }
      if (!envelope.operationId || envelope.writerEpoch === undefined || !envelope.expectedVersions) {
        throw structuredError('INVALID_INPUT', '影片编辑缺少操作包络')
      }
      const expectedVersions = envelope.expectedVersions
      const operationId = envelope.operationId
      const result = commitCatalogMutation(
        {
          operationId,
          operation: 'videos.edit',
          expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => {
          assertExpectedVideoVersion(input.videoId, expectedVersions, operationId, database)
          const ok = videoMaintenanceService.edit(
            input.videoId,
            videoEditInputFromManageFields(input.fields)
          )
          return {
            ok,
            videoId: input.videoId,
            versions: { V: readVideoAggregateVersion(input.videoId, database)! }
          }
        },
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    throw structuredError('UNSUPPORTED_CAPABILITY', `S05 尚未实现 ${operation}`)
  }

  throw structuredError('UNSUPPORTED_CAPABILITY', `S05 尚未实现 ${operation}`)
}
