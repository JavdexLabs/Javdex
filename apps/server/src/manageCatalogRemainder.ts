import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'
import { structuredError, toStructuredError, isStructuredError } from '@shared/protocol/errors'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { ManageOperationId } from '@shared/manage/operations'
import { commitCatalogMutation, readCatalogMutation } from '@library/catalog/catalogOperations'
import { MediaLibraryRepoError } from '@library/db/mediaLibraryRepo'
import type {
  LastVideoResourceRemovalMode,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoMergeInput
} from '@shared/videoTypes'
import type { OrganizationRole } from '@shared/classificationTypes'
import type {
  ResolveActressConflictInput,
  ValidateIllegalNameReplacementsInput
} from '@shared/actressConflictTypes'
import type {
  PendingScanGroupResolution,
  PendingResourceIdentityChoice,
  PendingResourceIdentityResolutionResult
} from '@shared/libraryTypes'
import { normalizeActressName } from '@library/db/actressNameNormalization'
import { videoMaintenanceService } from '@library/catalog/videoMaintenanceService'
import { videoLifecycleService } from '@library/catalog/videoLifecycleService'
import { VideoLifecycleRepoError } from '@library/db/videoLifecycleRepo'
import { actressIdentityConflictWorkflow } from '@library/catalog/actressIdentityConflictWorkflow'
import { organizationMergeService } from '@library/catalog/organizationMergeService'
import { directorMergeService } from '@library/catalog/directorMergeService'
import { seriesMergeService } from '@library/catalog/seriesMergeService'
import { organizationDeletionService } from '@library/catalog/organizationDeletionService'
import { classificationDeletionService } from '@library/catalog/classificationDeletionService'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'
import {
  assertExpectedClassificationVersion,
  readClassificationAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import { assertExpectedVideoVersion } from '@library/catalog/catalogVideoVersion'
import {
  countPendingVideoScrapes,
  deletePendingVideoScrape,
  existingPendingVideoScrapeIds,
  getPendingVideoScrapeById,
  listPendingVideoScrapes,
  pagePendingVideoScrapes
} from '@library/db/pendingVideoScrapeRepo'
import { getPendingAuditPresence } from '@library/db/pendingAuditRepo'
import { markScrapeFailed } from '@library/db/videoRepo'
import { mediaAssetStore } from '@library/mediaAssetStore'
import {
  countPendingScanQueue,
  pagePendingScanQueue
} from '@library/db/pendingScanQueueRepo'
import {
  getPendingScanGroup,
  listPendingScanGroups,
  PendingScanRepoError,
  resolvePendingScanGroup
} from '@library/db/pendingScanRepo'
import { selectAccessibleFallbackPrimaryResourceId } from '@library/scan/accessiblePrimaryResource'
import {
  getPendingResourceIdentity,
  listPendingResourceIdentities
} from '@library/db/pendingResourceIdentityRepo'
import {
  applyPreparedPendingResourceIdentityResolution,
  finishPreparedPendingResourceIdentityResolution,
  preparePendingResourceIdentityResolution
} from '@library/scan/pendingResourceIdentityService'
import { listMediaLibraries } from '@library/db/mediaLibraryRepo'
import {
  type CatalogHandler,
  type HandlerArgs,
  type ManageEnvelope
} from './manageCatalogHandlers'

function catalogDb(database?: Database.Database): Database.Database {
  return database ?? getDb()
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

function spreadMutation<T>(receipt: unknown, data: T): unknown {
  if (typeof data === 'boolean') return { receipt, ok: data }
  if (typeof data === 'number') return { receipt, id: data }
  if (data && typeof data === 'object') return { receipt, ...data }
  return { receipt, data }
}

function commit<T>(args: HandlerArgs, work: () => T): unknown {
  const mutation = requireMutation(args.envelope)
  const result = commitCatalogMutation(
    {
      operationId: mutation.operationId,
      operation: args.operation,
      expectedVersions: mutation.expectedVersions,
      input: args.envelope.input,
      writerEpoch: args.auth.epoch
    },
    work,
    args.database
  )
  return spreadMutation(result.receipt, result.data)
}

function runLibrary<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    if (error instanceof MediaLibraryRepoError) {
      if (error.code === 'REVISION_CONFLICT') {
        throw structuredError('VERSION_CONFLICT', error.message)
      }
      throw structuredError('INVALID_INPUT', error.message)
    }
    throw error
  }
}

function requireLibraryRevision(expected: ExpectedVersions, scope: 'L' | 'C', operationId: string): number {
  const version = expected[scope]
  if (!version) {
    throw structuredError(
      'INVALID_INPUT',
      scope === 'L' ? '媒体库更新需要 L 版本' : '媒体库配置需要 C 版本',
      { field: `expectedVersions.${scope}` },
      operationId
    )
  }
  return version.revision
}

function videoMutation(args: HandlerArgs, videoId: number, work: () => boolean): unknown {
  const mutation = requireMutation(args.envelope)
  return commit(args, () => {
    assertExpectedVideoVersion(videoId, mutation.expectedVersions, mutation.operationId, args.database)
    const ok = work()
    return {
      ok,
      versions: { V: readVideoAggregateVersion(videoId, args.database)! }
    }
  })
}

const mediaLibraries = createMediaLibraryService(
  createMediaLibraryServiceDependencies({
    isVideoScraperRunnable: () => true
  })
)

function sha256Digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requireQRevision(expected: ExpectedVersions, operationId: string): number {
  const version = expected.Q
  if (!version) {
    throw structuredError(
      'INVALID_INPUT',
      '待确认操作需要 Q 版本',
      { field: 'expectedVersions.Q' },
      operationId
    )
  }
  return version.revision
}

function runDomain<T>(work: () => T): T {
  try {
    return runLibrary(work)
  } catch (error) {
    if (error instanceof PendingScanRepoError) {
      if (error.code === 'REVISION_CONFLICT') {
        throw structuredError('VERSION_CONFLICT', error.message)
      }
      throw structuredError('INVALID_INPUT', error.message)
    }
    if (error instanceof VideoLifecycleRepoError) {
      if (error.code === 'REVISION_CONFLICT') {
        throw structuredError('VERSION_CONFLICT', error.message)
      }
      throw structuredError('INVALID_INPUT', error.message)
    }
    if (isStructuredError(error)) throw error
    throw toStructuredError(error)
  }
}

function existingPendingVideoScrapeIdsByVideo(videoIds: number[], database: Database.Database): number[] {
  const unique = [...new Set(videoIds)]
  if (!unique.length) return []
  return (
    database
      .prepare(
        `SELECT video_id FROM pending_video_scrapes
         WHERE video_id IN (${unique.map(() => '?').join(',')})
         ORDER BY video_id`
      )
      .all(...unique) as Array<{ video_id: number }>
  ).map((row) => row.video_id)
}

function lookupScanGroupLibrary(groupId: number, database = catalogDb()): number | null {
  const row = database
    .prepare('SELECT library_id FROM pending_scan_groups WHERE id = ?')
    .get(groupId) as { library_id: number } | undefined
  return row?.library_id ?? null
}

function lookupIdentityLibrary(identityId: number, database = catalogDb()): number | null {
  const row = database
    .prepare('SELECT library_id FROM pending_resource_identities WHERE id = ?')
    .get(identityId) as { library_id: number } | undefined
  return row?.library_id ?? null
}

function classificationCommit(
  args: HandlerArgs,
  kind: 'organization' | 'director' | 'series',
  id: number,
  work: () => unknown
): unknown {
  const mutation = requireMutation(args.envelope)
  return commit(args, () => {
    assertExpectedClassificationVersion(kind, id, mutation.expectedVersions, mutation.operationId, args.database)
    const data = runDomain(work)
    return {
      ...(data && typeof data === 'object' ? data : { ok: data }),
      versions: { F: readClassificationAggregateVersion(kind, id, args.database) }
    }
  })
}

function withPlanDigest<T extends object>(impact: T): T & { planDigest: string } {
  return { ...impact, planDigest: sha256Digest(impact) }
}

function assertPlanDigest(current: unknown, planDigest: string, operationId: string): void {
  if (sha256Digest(current) !== planDigest) {
    throw structuredError('VERSION_CONFLICT', '删除预览已过期，请刷新影响范围后重试', undefined, operationId)
  }
}

export const remainderHandlers: Partial<Record<ManageOperationId, CatalogHandler>> = {
  'videos.correctImport'(args) {
    const input = args.envelope.input as {
      videoId: number
      code: string
      discardPendingScrape: boolean
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, args.database)
      const result = runDomain(() =>
        videoMaintenanceService.correctImport(input.videoId, input.code, input.discardPendingScrape)
      )
      return {
        ...result,
        versions: { V: readVideoAggregateVersion(input.videoId, args.database)! }
      }
    })
  },
  'videos.importResource'(args) {
    const input = args.envelope.input as VideoLinkResourceImportInput
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      if (input.target.kind === 'existing') {
        assertExpectedVideoVersion(
          input.target.videoId,
          mutation.expectedVersions,
          mutation.operationId,
          args.database
        )
      }
      const result = runDomain(() => videoMaintenanceService.importLinkResource(input))
      return {
        ...result,
        versions: { V: readVideoAggregateVersion(result.videoId, args.database)! }
      }
    })
  },
  'videos.updateResource'(args) {
    const input = args.envelope.input as {
      libraryId: number
      videoId: number
      resourceId: number
    } & VideoLinkResourceUpdateInput
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, args.database)
      const resource = runDomain(() =>
        videoMaintenanceService.updateLinkResource(input.libraryId, input.videoId, input.resourceId, {
          url: input.url,
          kind: input.kind,
          displayName: input.displayName,
          sizeBytes: input.sizeBytes
        })
      )
      return {
        resource,
        versions: { V: readVideoAggregateVersion(input.videoId, args.database)! }
      }
    })
  },
  'videos.updateLocalResourceLabel'(args) {
    const input = args.envelope.input as {
      libraryId: number
      videoId: number
      resourceId: number
      label: string | null
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, args.database)
      const resource = runDomain(() =>
        videoMaintenanceService.updateLocalResourceLabel(
          input.libraryId,
          input.videoId,
          input.resourceId,
          input.label
        )
      )
      return {
        resource,
        versions: { V: readVideoAggregateVersion(input.videoId, args.database)! }
      }
    })
  },
  'videos.setPrimaryResource'(args) {
    const input = args.envelope.input as { libraryId: number; videoId: number; resourceId: number }
    return videoMutation(args, input.videoId, () =>
      videoMaintenanceService.setPrimaryResource(input.libraryId, input.videoId, input.resourceId)
    )
  },
  'videos.removeResource'(args) {
    const input = args.envelope.input as {
      libraryId: number
      videoId: number
      resourceId: number
      lastResourceMode?: LastVideoResourceRemovalMode
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, args.database)
      const result = runDomain(() =>
        videoMaintenanceService.removeResource(
          input.libraryId,
          input.videoId,
          input.resourceId,
          input.lastResourceMode
        )
      )
      const versions = result.videoDeleted
        ? {}
        : { V: readVideoAggregateVersion(input.videoId, args.database)! }
      return { ...result, versions }
    })
  },
  'videos.previewRemoveFromLibrary'(args) {
    const input = args.envelope.input as { libraryId: number; videoId: number }
    return runDomain(() => videoLifecycleService.previewRemoveFromLibrary(input.libraryId, input.videoId))
  },
  'videos.removeFromLibrary'(args) {
    const input = args.envelope.input as {
      libraryId: number
      videoId: number
      planId: string
      planDigest: string
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runDomain(() =>
        videoLifecycleService.removeFromLibrary({
          libraryId: input.libraryId,
          videoId: input.videoId,
          operationId: mutation.operationId,
          expectedRevision: input.planDigest
        })
      )
    )
  },
  'videos.previewMoveResource'(args) {
    const input = args.envelope.input as {
      sourceLibraryId: number
      targetLibraryId: number
      resourceId: number
    }
    return runDomain(() =>
      videoLifecycleService.previewMoveResource(
        input.sourceLibraryId,
        input.targetLibraryId,
        input.resourceId
      )
    )
  },
  'videos.moveResource'(args) {
    const input = args.envelope.input as {
      sourceLibraryId: number
      targetLibraryId: number
      resourceId: number
      planId: string
      planDigest: string
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runDomain(() =>
        videoLifecycleService.moveResource({
          sourceLibraryId: input.sourceLibraryId,
          targetLibraryId: input.targetLibraryId,
          resourceId: input.resourceId,
          operationId: mutation.operationId,
          expectedRevision: input.planDigest
        })
      )
    )
  },
  'videos.previewDeleteGlobal'(args) {
    const input = args.envelope.input as { videoId: number }
    return runDomain(() => videoLifecycleService.previewDeleteGlobally(input.videoId))
  },
  'videos.deleteGlobal'(args) {
    const input = args.envelope.input as { videoId: number; planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runDomain(() =>
        videoLifecycleService.deleteGlobally({
          videoId: input.videoId,
          operationId: mutation.operationId,
          expectedRevision: input.planDigest
        })
      )
    )
  },
  'videos.merge'(args) {
    const input = args.envelope.input as VideoMergeInput
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(
        input.retainedVideoId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const result = runDomain(() => videoMaintenanceService.mergeVideos(input))
      return {
        ...result,
        versions: { V: readVideoAggregateVersion(result.retainedVideoId, args.database)! }
      }
    })
  },
  'videos.splitResource'(args) {
    const input = args.envelope.input as { libraryId: number; videoId: number; resourceId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedVideoVersion(input.videoId, mutation.expectedVersions, mutation.operationId, args.database)
      const result = runDomain(() =>
        videoMaintenanceService.splitResource(input.libraryId, input.videoId, input.resourceId)
      )
      return {
        ...result,
        versions: { V: readVideoAggregateVersion(result.videoId, args.database)! }
      }
    })
  },
  'pendingVideoScrapes.count'() {
    return countPendingVideoScrapes()
  },
  'pendingVideoScrapes.existingIds'(args) {
    const input = args.envelope.input as { scrapeIds?: number[]; videoIds?: number[] }
    return runDomain(() => {
      if (input.scrapeIds) return existingPendingVideoScrapeIds(input.scrapeIds)
      if (input.videoIds?.length) {
        return existingPendingVideoScrapeIdsByVideo(input.videoIds, catalogDb(args.database))
      }
      return (
        catalogDb(args.database)
          .prepare('SELECT video_id FROM pending_video_scrapes ORDER BY video_id')
          .all() as Array<{ video_id: number }>
      ).map((row) => row.video_id)
    })
  },
  'pendingVideoScrapes.page'(args) {
    const input = args.envelope.input as {
      limit?: number
      offset?: number
      anchorId?: number
      videoId?: number
    }
    return runDomain(() =>
      pagePendingVideoScrapes({
        offset: input.offset,
        limit: Math.min(input.limit ?? 50, 100),
        ...(input.anchorId != null ? { anchorId: input.anchorId } : {}),
        ...(input.videoId != null ? { videoId: input.videoId } : {})
      })
    )
  },
  'pendingVideoScrapes.get'(args) {
    const input = args.envelope.input as { pendingScrapeId: number }
    return getPendingVideoScrapeById(input.pendingScrapeId)
  },
  'pendingVideoScrapes.list'() {
    return listPendingVideoScrapes()
  },
  'pendingVideoScrapes.discard'(args) {
    const input = args.envelope.input as { pendingScrapeId: number }
    const mutation = requireMutation(args.envelope)
    const expectedRevision = requireQRevision(mutation.expectedVersions, mutation.operationId)
    let stagedPaths: string[] = []
    const result = commit(args, () => {
      const pending = catalogDb(args.database)
        .prepare('SELECT revision FROM pending_video_scrapes WHERE id = ?')
        .get(input.pendingScrapeId) as { revision: number } | undefined
      if (!pending || pending.revision !== expectedRevision) {
        throw structuredError('VERSION_CONFLICT', '待确认刮削结果已变化，请刷新后重新确认')
      }
      const deleted = deletePendingVideoScrape(input.pendingScrapeId)
      if (!deleted) return { ok: false }
      markScrapeFailed(deleted.videoId)
      stagedPaths = deleted.stagedPaths
      return { ok: true }
    })
    if (stagedPaths.length > 0) mediaAssetStore.cleanupVideoScrapeStagingPaths(stagedPaths)
    return result
  },
  'actressConflicts.inspectName'(args) {
    const input = args.envelope.input as { name: string }
    const normalizedName = normalizeActressName(input.name.trim())
    const group = actressIdentityConflictWorkflow.getConflictGroup(normalizedName)
    return { normalizedName, status: group ? 'conflict' : 'available' }
  },
  'actressConflicts.discard'(args) {
    const input = args.envelope.input as { pendingId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runDomain(() =>
        actressIdentityConflictWorkflow.discardPendingScrape({
          pendingId: input.pendingId,
          expectedRevision: requireQRevision(mutation.expectedVersions, mutation.operationId)
        })
      )
    )
  },
  'actressConflicts.validateIllegal'(args) {
    const input = args.envelope.input as { pendingId: number; replacements: unknown }
    const replacements = input.replacements as ValidateIllegalNameReplacementsInput | undefined
    if (!replacements || typeof replacements !== 'object' || !('snapshot' in replacements)) {
      throw structuredError('INVALID_INPUT', '非法名校验缺少 snapshot')
    }
    return actressIdentityConflictWorkflow.validateIllegalNameReplacements(replacements)
  },
  'actressConflicts.resolve'(args) {
    const input = args.envelope.input as { pendingId: number; choices: unknown }
    const choices = input.choices as ResolveActressConflictInput | undefined
    if (!choices || typeof choices !== 'object' || !('kind' in choices) || !('snapshot' in choices)) {
      throw structuredError('INVALID_INPUT', '冲突解决缺少 choices')
    }
    return commit(args, () => runDomain(() => actressIdentityConflictWorkflow.resolveConflict(choices)))
  },
  'organizations.merge'(args) {
    const input = args.envelope.input as { targetId: number; sourceId: number }
    return classificationCommit(args, 'organization', input.targetId, () =>
      organizationMergeService.merge(input)
    )
  },
  'organizations.roleRemovePreview'(args) {
    const input = args.envelope.input as { organizationId: number; role: OrganizationRole }
    return withPlanDigest(
      organizationDeletionService.previewRoleRemoval(input.organizationId, input.role)
    )
  },
  'organizations.roleRemove'(args) {
    const input = args.envelope.input as {
      organizationId: number
      role: OrganizationRole
      planId: string
      planDigest: string
    }
    const mutation = requireMutation(args.envelope)
    return classificationCommit(args, 'organization', input.organizationId, () => {
      assertPlanDigest(
        organizationDeletionService.previewRoleRemoval(input.organizationId, input.role),
        input.planDigest,
        mutation.operationId
      )
      return organizationDeletionService.removeRole(input.organizationId, input.role)
    })
  },
  'organizations.deletePreview'(args) {
    const input = args.envelope.input as { organizationId: number }
    return withPlanDigest(organizationDeletionService.previewOrganization(input.organizationId))
  },
  'organizations.delete'(args) {
    const input = args.envelope.input as { organizationId: number; planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'organization',
        input.organizationId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      assertPlanDigest(
        organizationDeletionService.previewOrganization(input.organizationId),
        input.planDigest,
        mutation.operationId
      )
      return runDomain(() => organizationDeletionService.deleteOrganization(input.organizationId))
    })
  },
  'directors.merge'(args) {
    const input = args.envelope.input as { targetId: number; sourceId: number }
    return classificationCommit(args, 'director', input.targetId, () => directorMergeService.merge(input))
  },
  'directors.deletePreview'(args) {
    const input = args.envelope.input as { directorId: number }
    return withPlanDigest(classificationDeletionService.previewDirector(input.directorId))
  },
  'directors.delete'(args) {
    const input = args.envelope.input as { directorId: number; planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'director',
        input.directorId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      assertPlanDigest(
        classificationDeletionService.previewDirector(input.directorId),
        input.planDigest,
        mutation.operationId
      )
      return runDomain(() => classificationDeletionService.deleteDirector(input.directorId))
    })
  },
  'series.merge'(args) {
    const input = args.envelope.input as { targetId: number; sourceId: number }
    return classificationCommit(args, 'series', input.targetId, () => seriesMergeService.merge(input))
  },
  'series.deletePreview'(args) {
    const input = args.envelope.input as { seriesId: number }
    return withPlanDigest(classificationDeletionService.previewSeries(input.seriesId))
  },
  'series.delete'(args) {
    const input = args.envelope.input as { seriesId: number; planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'series',
        input.seriesId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      assertPlanDigest(
        classificationDeletionService.previewSeries(input.seriesId),
        input.planDigest,
        mutation.operationId
      )
      return runDomain(() => classificationDeletionService.deleteSeries(input.seriesId))
    })
  },
  'libraries.delete'(args) {
    const input = args.envelope.input as { libraryId: number; planId: string; planDigest: string }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runLibrary(() =>
        mediaLibraries.remove({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
          expectedImpactRevision: input.planDigest
        })
      )
    )
  },
  'pendingAudit.presence'(args) {
    const input = args.envelope.input as {
      libraryId: number
      groupIds?: number[]
      identityIds?: number[]
      scrapeIds?: number[]
    }
    return runDomain(() =>
      getPendingAuditPresence(input.libraryId, {
        groupIds: input.groupIds ?? [],
        identityIds: input.identityIds ?? [],
        scrapeIds: input.scrapeIds ?? []
      })
    )
  },
  'pendingScan.queuePage'(args) {
    const input = args.envelope.input as {
      libraryId?: number
      limit?: number
      offset?: number
      anchor?: { kind: 'group' | 'identity'; id: number }
    }
    return runDomain(() =>
      pagePendingScanQueue({
        libraryId: input.libraryId,
        offset: input.offset,
        limit: Math.min(input.limit ?? 50, 100),
        ...(input.anchor ? { anchor: input.anchor } : {})
      })
    )
  },
  'pendingScan.queueCount'(args) {
    const input = args.envelope.input as { libraryId?: number }
    return countPendingScanQueue(input.libraryId)
  },
  'pendingScan.get'(args) {
    const input = args.envelope.input as { groupId: number }
    const libraryId = lookupScanGroupLibrary(input.groupId, catalogDb(args.database))
    if (libraryId == null) return null
    return getPendingScanGroup(libraryId, input.groupId)
  },
  'pendingScan.list'(args) {
    const input = args.envelope.input as { libraryId?: number }
    if (input.libraryId) return listPendingScanGroups(input.libraryId)
    return listMediaLibraries({ includeArchived: true }, catalogDb(args.database)).flatMap((library) =>
      listPendingScanGroups(library.id)
    )
  },
  'pendingScan.resolve'(args) {
    const input = args.envelope.input as Omit<PendingScanGroupResolution, 'expectedRevision'> & {
      groupId: number
    }
    const mutation = requireMutation(args.envelope)
    const libraryId = lookupScanGroupLibrary(input.groupId, catalogDb(args.database))
    if (libraryId == null) throw structuredError('INVALID_INPUT', '待确认扫描组不存在')
    return commit(args, () =>
      runDomain(() =>
        resolvePendingScanGroup(
          libraryId,
          input.groupId,
          {
            expectedRevision: requireQRevision(mutation.expectedVersions, mutation.operationId),
            assignments: input.assignments,
            primaryResourceIds: input.primaryResourceIds
          },
          { selectFallbackPrimaryResourceId: selectAccessibleFallbackPrimaryResourceId }
        )
      )
    )
  },
  'pendingResourceIdentity.get'(args) {
    const input = args.envelope.input as { identityId: number }
    const libraryId = lookupIdentityLibrary(input.identityId, catalogDb(args.database))
    if (libraryId == null) return null
    return getPendingResourceIdentity(libraryId, input.identityId)
  },
  'pendingResourceIdentity.list'(args) {
    const input = args.envelope.input as { libraryId?: number }
    if (input.libraryId) return listPendingResourceIdentities(input.libraryId)
    return listMediaLibraries({ includeArchived: true }, catalogDb(args.database)).flatMap((library) =>
      listPendingResourceIdentities(library.id)
    )
  },
  async 'pendingResourceIdentity.resolve'(args) {
    const input = args.envelope.input as {
      identityId: number
      choice: PendingResourceIdentityChoice
    }
    const mutation = requireMutation(args.envelope)
    const request = {
      operationId: mutation.operationId,
      operation: args.operation,
      expectedVersions: mutation.expectedVersions,
      input: args.envelope.input,
      writerEpoch: args.auth.epoch
    }
    const duplicate = readCatalogMutation<PendingResourceIdentityResolutionResult>(request, args.database)
    if (duplicate) return spreadMutation(duplicate.receipt, duplicate.data)
    const libraryId = lookupIdentityLibrary(input.identityId, catalogDb(args.database))
    if (libraryId == null) throw structuredError('INVALID_INPUT', '资源身份待办不存在')
    const prepared = await preparePendingResourceIdentityResolution(libraryId, input.identityId, {
      expectedRevision: requireQRevision(mutation.expectedVersions, mutation.operationId),
      choice: input.choice
    })
    const committed = commit(args, () => {
      const assignment = applyPreparedPendingResourceIdentityResolution(prepared)
      return {
        ...assignment,
        warnings: prepared.choice === 'discard' ? [] : prepared.inspection.warnings
      }
    })
    const committedResult = committed as {
      receipt: unknown
      status: 'assigned' | 'pending' | 'discarded'
      videoId?: number
      pendingGroupId?: number
    }
    const assignment = committedResult.status === 'assigned'
      ? committedResult.videoId == null
        ? (() => { throw new Error('资源归属提交结果缺少影片编号。') })()
        : { status: 'assigned' as const, videoId: committedResult.videoId }
      : committedResult.status === 'pending'
        ? committedResult.pendingGroupId == null
          ? (() => { throw new Error('资源归属提交结果缺少待确认组编号。') })()
          : { status: 'pending' as const, pendingGroupId: committedResult.pendingGroupId }
        : { status: 'discarded' as const }
    const finished = await finishPreparedPendingResourceIdentityResolution(prepared, assignment)
    return { receipt: committedResult.receipt, ...finished }
  }
}
