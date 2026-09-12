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
import { assertExpectedVideoVersion, readVideoAggregateVersion } from '@library/catalog/catalogVideoVersion'
import {
  applyActressAvatarRef,
  applyActressCropRef,
  applyActressGalleryRefs,
  applyClassificationImageRef,
  applyPlaylistCoverRef,
  applyVideoCoverRef,
  applyVideoPosterRef,
  applyVideoSampleRefs,
  commitManageImageMutation
} from '@library/catalog/catalogImageApply'
import { maybeCrashImageFlow } from '@library/catalog/catalogImageCrash'
import {
  completeCatalogUploadFromStream,
  createCatalogUpload,
  inspectCatalogUpload
} from '@library/catalog/catalogUploads'
import type { CatalogImageRef, UploadPurpose } from '@shared/protocol/uploads'
import type { ManageImageContentType } from '@shared/protocol/limits'
import { MANAGE_OPERATIONS, type ManageOperationId } from '@shared/manage/operations'
import { parseManageRequest } from '@shared/manage/parse'
import type { ManageHttpContext, ManageUploadPutContext } from '@http/manage'
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
  context: { bearerSecret: string | null },
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

function requireMutation(envelope: ManageEnvelope): {
  operationId: string
  writerEpoch: number
  expectedVersions: ExpectedVersions
} {
  if (!envelope.operationId || envelope.writerEpoch === undefined || !envelope.expectedVersions) {
    throw structuredError('INVALID_INPUT', '写入请求缺少操作包络')
  }
  return {
    operationId: envelope.operationId,
    writerEpoch: envelope.writerEpoch,
    expectedVersions: envelope.expectedVersions
  }
}

export async function putManageUpload(
  context: ManageUploadPutContext,
  database?: Database.Database
): Promise<unknown> {
  const identity = requireIdentity()
  const auth = requireBearer(context, {
    serverId: identity.serverId!,
    catalogId: identity.catalogId
  })
  return completeCatalogUploadFromStream(
    context.uploadId,
    context.request,
    {
      writerEpoch: auth.epoch,
      catalogId: identity.catalogId
    },
    database
  )
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
    throw structuredError('UNSUPPORTED_CAPABILITY', `S06 尚未实现 ${operation}`)
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
    if (operation === 'uploads.inspect') {
      return inspectCatalogUpload((envelope.input as { uploadId: string }).uploadId, {}, database)
    }
    if (operation === 'uploads.create') {
      const mutation = requireMutation(envelope)
      const input = envelope.input as { purpose: UploadPurpose; contentType: ManageImageContentType }
      const result = commitCatalogMutation(
        {
          operationId: mutation.operationId,
          operation: 'uploads.create',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () =>
          createCatalogUpload(
            {
              purpose: input.purpose,
              contentType: input.contentType,
              writerEpoch: auth.epoch,
              catalogId: envelope.catalogId!
            },
            database
          ),
        database
      )
      maybeCrashImageFlow('afterPersistUploadRow')
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'videos.edit') {
      const input = envelope.input as {
        videoId: number
        fields: Parameters<typeof videoEditInputFromManageFields>[0] & { cover?: CatalogImageRef }
      }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'videos.edit',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => {
          assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, database)
          if (input.fields.cover) {
            applyVideoCoverRef(
              input.videoId,
              input.fields.cover,
              mutation.expectedVersions,
              mutation.operationId,
              database,
              { bumpRevision: false }
            )
          }
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
    if (operation === 'videos.setPoster') {
      const input = envelope.input as { videoId: number; image: CatalogImageRef }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'videos.setPoster',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => applyVideoPosterRef(input.videoId, input.image, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'videos.importSamples') {
      const input = envelope.input as { videoId: number; images: CatalogImageRef[] }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'videos.importSamples',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => applyVideoSampleRefs(input.videoId, input.images, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'actresses.setPoster') {
      const input = envelope.input as { actressId: number; image: CatalogImageRef }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'actresses.setPoster',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => applyActressAvatarRef(input.actressId, input.image, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'actresses.importGallery') {
      const input = envelope.input as { actressId: number; images: CatalogImageRef[] }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'actresses.importGallery',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => applyActressGalleryRefs(input.actressId, input.images, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'actresses.applyCrop') {
      const input = envelope.input as {
        actressId: number
        sourceAssetId: number
        sourceDigest: string
        sourceVersion: string
        image: CatalogImageRef
      }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'actresses.applyCrop',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () => applyActressCropRef(input, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'classificationImages.set') {
      const input = envelope.input as {
        entity: { kind: 'organization' | 'director' | 'series'; id: number }
        image: CatalogImageRef | { kind: 'videoCover'; videoId: number }
      }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'classificationImages.set',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () =>
          applyClassificationImageRef(input.entity, input.image, mutation.expectedVersions, mutation.operationId, database),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'playlists.create') {
      const input = envelope.input as {
        name: string
        description?: string | null
        cover?: CatalogImageRef
      }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'playlists.create',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () =>
          applyPlaylistCoverRef(
            null,
            input.cover,
            { name: input.name, description: input.description },
            mutation.expectedVersions,
            mutation.operationId,
            database
          ),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    if (operation === 'playlists.update') {
      const input = envelope.input as {
        playlistId: number
        name: string
        description?: string | null
        cover?: CatalogImageRef
      }
      const mutation = requireMutation(envelope)
      const result = commitManageImageMutation(
        {
          operationId: mutation.operationId,
          operation: 'playlists.update',
          expectedVersions: mutation.expectedVersions,
          input,
          writerEpoch: auth.epoch
        },
        () =>
          applyPlaylistCoverRef(
            input.playlistId,
            input.cover,
            { name: input.name, description: input.description },
            mutation.expectedVersions,
            mutation.operationId,
            database
          ),
        database
      )
      return { receipt: result.receipt, ...result.data }
    }
    throw structuredError('UNSUPPORTED_CAPABILITY', `S06 尚未实现 ${operation}`)
  }

  throw structuredError('UNSUPPORTED_CAPABILITY', `S06 尚未实现 ${operation}`)
}
