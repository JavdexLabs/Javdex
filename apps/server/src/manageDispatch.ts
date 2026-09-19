import { catalogVideoCommands } from '@library/catalog/catalogVideoCommands'
import type Database from 'better-sqlite3'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { scopedVideoCatalogRepo } from '@library/db/scopedVideoCatalogRepo'
import { getVideoDetail } from '@library/db/videoRepo'
import { listMediaLibraries } from '@library/db/mediaLibraryRepo'
import { getLibraryOverviewStats } from '@library/db/overviewRepo'
import { createHomeDiscoveryRepo } from '@library/db/homeDiscoveryRepo'
import { getDb } from '@library/db/database'
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
  applyActressAvatarRef,
  applyActressCropRef,
  applyActressGalleryRefs,
  applyClassificationImageRef,
  applyPlaylistCoverRef,
  applyVideoPosterRef,
  applyVideoSampleRefs,
  commitManageImageMutation
} from '@library/catalog/catalogImageApply'
import { maybeCrashImageFlow } from '@library/catalog/catalogImageCrash'
import { grantCatalogPlayback } from '@library/catalog/catalogPlay'
import { readManageCatalogImage } from '@library/catalog/catalogManageImages'
import { authenticateMigration } from '@library/catalog/catalogMigrationAuth'
import {
  abandonCatalogMigration,
  enableCatalogMigration,
  migrationPackagePath,
  previewCatalogMigration,
  startCatalogMigration,
  statusCatalogMigration
} from '@library/catalog/catalogMigration'
import {
  completeCatalogUploadFromStream,
  createCatalogUpload,
  inspectCatalogUpload
} from '@library/catalog/catalogUploads'
import type { CatalogImageRef, UploadPurpose } from '@shared/protocol/uploads'
import { MIGRATION_PACKAGE_MAX_BYTES, type ManageImageContentType } from '@shared/protocol/limits'
import { MANAGE_OPERATIONS, type ManageOperationId } from '@shared/manage/operations'
import { parseManageRequest } from '@shared/manage/parse'
import type { ManageHttpContext, ManageUploadPutContext, ManageAssetGetContext, ManageMigrationPackagePutContext } from '@http/manage'
import { structuredError } from '@shared/protocol/errors'
import type { OperationReceipt } from '@shared/protocol/operationReceipt'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { MigrationAbandonInput, MigrationControlInput, MigrationEnableInput, MigrationPreviewInput } from '@shared/protocol/migration'
import { SERVER_APP_VERSION } from './appVersion'
import { CATALOG_NOT_HANDLED, dispatchCatalogManage, projectRemoteVideoDetail } from './manageCatalogHandlers'
import { readManageBrowserEnabled } from './manageBrowser'

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

function catalogDb(database?: Database.Database): Database.Database {
  return database ?? getDb()
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

export async function putManageMigrationPackage(
  context: ManageMigrationPackagePutContext,
  database?: Database.Database
): Promise<{ ok: true; bytes: number }> {
  const db = catalogDb(database)
  authenticateMigration(context.bearerSecret, db)
  const dest = migrationPackagePath(context.migrationId, { appVersion: SERVER_APP_VERSION })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let written = 0
  const output = fs.createWriteStream(dest)
  const counting = new Transform({
    transform(chunk, _enc, callback) {
      written += chunk.length
      if (written > MIGRATION_PACKAGE_MAX_BYTES) {
        callback(new Error('LIMIT_EXCEEDED:migration-package'))
        return
      }
      callback(null, chunk)
    }
  })
  try {
    await pipeline(context.request, counting, output)
  } catch (error) {
    output.destroy()
    fs.rmSync(dest, { force: true })
    if (error instanceof Error && error.message === 'LIMIT_EXCEEDED:migration-package') {
      throw structuredError('LIMIT_EXCEEDED', '迁移包超过大小上限', {
        limit: MIGRATION_PACKAGE_MAX_BYTES,
        actual: written
      })
    }
    throw error
  }
  return { ok: true, bytes: written }
}

export async function getManageAsset(
  context: ManageAssetGetContext,
  _database?: Database.Database
): Promise<{ body: Buffer; mime: string }> {
  const identity = requireIdentity()
  requireBearer(context, {
    serverId: identity.serverId!,
    catalogId: identity.catalogId
  })
  return readManageCatalogImage(context.relPath, context.signal, context.size)
}

/** Test-only: if `JAVDEX_TEST_STALL_VIDEOS_EDIT` names an existing file, consume it and delay after commit. */
function stallVideosEditForTests(): Promise<void> | null {
  const stallPath = process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT
  if (!stallPath) return null
  try {
    fs.unlinkSync(stallPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  fs.writeFileSync(`${stallPath}.started`, '1')
  const delayMs = Number(process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_MS ?? 8_000)
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 8_000))
}

/** Test-only: pause before the mutation transaction so another request can claim a new writer. */
function stallVideosEditBeforeMutationForTests(): Promise<void> | null {
  const stallPath = process.env.JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE
  if (!stallPath) return null
  try {
    fs.unlinkSync(stallPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  fs.writeFileSync(`${stallPath}.started`, '1')
  const donePath = `${stallPath}.done`
  const deadline = Date.now() + 15_000
  return (async () => {
    while (!fs.existsSync(donePath)) {
      if (Date.now() > deadline) {
        throw new Error('JAVDEX_TEST_STALL_VIDEOS_EDIT_BEFORE timed out')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })()
}

export function dispatchManageOperation(context: ManageHttpContext, database?: Database.Database): unknown {
  const operation = context.operation
  const meta = MANAGE_OPERATIONS[operation]
  if (operation === 'handshake.get') {
    parseEnvelope('handshake.get', context.body)
    return readHandshake(
      { appVersion: SERVER_APP_VERSION, browserEnabled: readManageBrowserEnabled() },
      database
    )
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
  if (meta.auth === 'migration') {
    const parsed = parseManageRequest(operation, context.body)
    if (!parsed.success) throw structuredError('INVALID_INPUT', '请求格式无效')
    authenticateMigration(context.bearerSecret, catalogDb(database))
    const envelope = parsed.data as {
      migrationId?: string
      digest?: string
      input: Record<string, unknown>
    }
    const input = envelope.input
    if (
      typeof input.migrationId === 'string' &&
      envelope.migrationId &&
      envelope.migrationId !== input.migrationId
    ) {
      throw structuredError('INVALID_INPUT', '迁移编号不一致')
    }
    const host = { appVersion: SERVER_APP_VERSION }
    if (operation === 'migration.preview') {
      return previewCatalogMigration(input as unknown as MigrationPreviewInput, host, catalogDb(database))
    }
    if (operation === 'migration.start') {
      return startCatalogMigration(input as unknown as MigrationControlInput, host, catalogDb(database))
    }
    if (operation === 'migration.status') {
      return statusCatalogMigration(input as unknown as { migrationId: string }, catalogDb(database))
    }
    if (operation === 'migration.enable') {
      return enableCatalogMigration(input as unknown as MigrationEnableInput, host, catalogDb(database))
    }
    if (operation === 'migration.abandon') {
      return abandonCatalogMigration(input as unknown as MigrationAbandonInput, host, catalogDb(database))
    }
    throw structuredError('UNSUPPORTED_CAPABILITY', `尚未实现 ${operation}`)
  }
  if (meta.auth === 'publicHandshake') {
    throw structuredError('UNSUPPORTED_CAPABILITY', `尚未实现 ${operation}`)
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
    if (operation === 'videos.list') {
      const input = envelope.input as {
        scope: Parameters<typeof scopedVideoCatalogRepo.list>[0]
        query?: Parameters<typeof scopedVideoCatalogRepo.list>[1]
      }
      return scopedVideoCatalogRepo.list(input.scope, input.query)
    }
    if (operation === 'videos.get') {
      const input = envelope.input as {
        scope: Parameters<typeof scopedVideoCatalogRepo.get>[0]
        videoId: number
      }
      const scoped = scopedVideoCatalogRepo.get(input.scope, input.videoId)
      if (scoped) return projectRemoteVideoDetail(scoped)
      const detail = getVideoDetail(input.videoId, catalogDb(database))
      if (!detail) return null
      return projectRemoteVideoDetail({
        ...detail,
        activeLibraryId: 0,
        membershipAddedAt: '',
        libraries: []
      })
    }
    if (operation === 'libraries.list') {
      const input = envelope.input as { includeArchived?: boolean }
      return listMediaLibraries({ includeArchived: input.includeArchived === true }, catalogDb(database))
    }
    if (operation === 'catalog.overviewStats') {
      return getLibraryOverviewStats(catalogDb(database))
    }
    if (operation === 'home.load') {
      const input = envelope.input as {
        seed: string
        recentLimit?: number
        discoveryLimit?: number
        libraryIds?: number[]
      }
      return createHomeDiscoveryRepo({ database: catalogDb(database) }).load(input)
    }
    if (operation === 'uploads.inspect') {
      return inspectCatalogUpload((envelope.input as { uploadId: string }).uploadId, {}, database)
    }
    if (operation === 'play.grant') {
      const input = envelope.input as {
        libraryId: number
        videoId: number
        resourceId: number
        locatorRevision: string
      }
      const origin = context.host ? `http://${context.host}` : undefined
      return grantCatalogPlayback(input, { publicOrigin: origin }, catalogDb(database))
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
      const input = envelope.input as Parameters<typeof catalogVideoCommands.edit>[0]
      const mutation = requireMutation(envelope)
      const run = () => {
        const result = catalogVideoCommands.edit(input, { ...mutation, writerEpoch: auth.epoch, database })
        const payload = { receipt: result.receipt, ...result.data }
        const stalled = stallVideosEditForTests()
        return stalled ? stalled.then(() => payload) : payload
      }
      const before = stallVideosEditBeforeMutationForTests()
      return before ? before.then(run) : run()
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
    const catalogResult = dispatchCatalogManage(operation, envelope, auth, database)
    if (catalogResult !== CATALOG_NOT_HANDLED) return catalogResult
    throw structuredError('UNSUPPORTED_CAPABILITY', `尚未实现 ${operation}`)
  }

  throw structuredError('UNSUPPORTED_CAPABILITY', `尚未实现 ${operation}`)
}
