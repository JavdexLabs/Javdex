import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'
import { createHomeDiscoveryRepo } from '@library/db/homeDiscoveryRepo'
import { scopedVideoCatalogRepo } from '@library/db/scopedVideoCatalogRepo'
import { getVideoResourceInLibrary } from '@library/db/videoRepo'
import { getMediaLibraryDetail, MediaLibraryRepoError } from '@library/db/mediaLibraryRepo'
import {
  addVideoToPlaylist,
  getPlaylistDetail,
  getPlaylistMetadata,
  getPlaylistPage,
  listPlaylistVideoPage,
  listPlaylists,
  listPlaylistsForVideo,
  removeVideoFromPlaylist
} from '@library/db/playlistRepo'
import { listPlaylistBrowsePage } from '@library/db/playlistListPageRepo'
import { tagQueryService } from '@library/catalog/tagQueryService'
import { actressQueryService } from '@library/catalog/actressQueryService'
import { actressMaintenanceService } from '@library/catalog/actressMaintenanceService'
import { actressIdentityConflictWorkflow } from '@library/catalog/actressIdentityConflictWorkflow'
import { classificationQueryService } from '@library/catalog/classificationQueryService'
import { classificationMaintenanceService } from '@library/catalog/classificationMaintenanceService'
import { videoMaintenanceService } from '@library/catalog/videoMaintenanceService'
import { deletePlaylist } from '@library/catalog/playlistService'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'
import { commitCatalogMutation } from '@library/catalog/catalogOperations'
import { commitManageImageMutation, applyActressAvatarRef } from '@library/catalog/catalogImageApply'
import {
  assertExpectedActressVersion,
  assertExpectedClassificationVersion,
  assertExpectedPlaylistVersion,
  assertExpectedVideoVersion,
  readActressAggregateVersion,
  readClassificationAggregateVersion,
  readPlaylistAggregateVersion,
  readVideoAggregateVersion
} from '@library/catalog/catalogAggregateVersion'
import { structuredError } from '@shared/protocol/errors'
import type { ExpectedVersions } from '@shared/protocol/versions'
import type { ManageOperationId } from '@shared/manage/operations'
import type { CatalogImageRef } from '@shared/protocol/uploads'
import type { ActressEditInput, ActressGenderFilter, ActressListQuery, ActressListSortBy } from '@shared/actressTypes'
import type { TagOptionsQuery, SortDir } from '@shared/commonTypes'
import type { GlobalSearchInput } from '@shared/catalogTypes'
import type {
  ClassificationEntityRef,
  ClassificationPageQuery,
  DirectorProfileInput,
  OrganizationCreateInput,
  OrganizationRole,
  OrganizationUpdateInput,
  SeriesProfileInput,
  SeriesUpdateInput
} from '@shared/classificationTypes'
import type {
  CatalogScope,
  CreateMediaLibraryInput,
  MediaLibraryConfigPatch,
  MediaLibraryPatch
} from '@shared/mediaLibraryTypes'
import type { PlaylistListQuery, PlaylistPageQuery } from '@shared/playlistTypes'
import { remainderHandlers } from './manageCatalogRemainder'
import { maintenanceHandlers } from './manageCatalogMaintenance'
import { requireManageBrowserSurface } from './manageBrowser'

export interface ManageEnvelope {
  serverId?: string
  catalogId?: string
  writerEpoch?: number
  operationId?: string
  expectedVersions?: ExpectedVersions
  input: unknown
}

export const CATALOG_NOT_HANDLED: unique symbol = Symbol('catalog-not-handled')

export interface HandlerArgs {
  operation: ManageOperationId
  envelope: ManageEnvelope
  auth: { epoch: number }
  database?: Database.Database
}

export type CatalogHandler = (args: HandlerArgs) => unknown | Promise<unknown>

const mediaLibraries = createMediaLibraryService(
  createMediaLibraryServiceDependencies({
    isVideoScraperRunnable: () => true
  })
)

export function catalogDb(database?: Database.Database): Database.Database {
  return database ?? getDb()
}

export function requireMutation(envelope: ManageEnvelope): {
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

export function commit<T>(args: HandlerArgs, work: () => T): unknown {
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

function commitImage<T>(args: HandlerArgs, work: () => T): unknown {
  const mutation = requireMutation(args.envelope)
  const result = commitManageImageMutation(
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

export function runLibrary<T>(work: () => T): T {
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

export function requireLibraryRevision(expected: ExpectedVersions, scope: 'L' | 'C', operationId: string): number {
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

export function videoMutation(
  args: HandlerArgs,
  videoId: number,
  work: () => boolean
): unknown {
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

const handlers: Partial<Record<ManageOperationId, CatalogHandler>> = {
  'home.search'(args) {
    const input = args.envelope.input as GlobalSearchInput
    return createHomeDiscoveryRepo({ database: catalogDb(args.database) }).search(input)
  },
  'videos.years'(args) {
    const input = args.envelope.input as { scope: CatalogScope }
    return scopedVideoCatalogRepo.listYears(input.scope)
  },
  'videos.getResource'(args) {
    const input = args.envelope.input as { libraryId: number; videoId: number; resourceId: number }
    const resource = getVideoResourceInLibrary(input.libraryId, input.resourceId)
    return resource?.video_id === input.videoId ? resource : null
  },
  'videos.setRating'(args) {
    const input = args.envelope.input as { videoId: number; rating: number }
    return videoMutation(args, input.videoId, () => videoMaintenanceService.setRating(input.videoId, input.rating))
  },
  'videos.clearMeta'(args) {
    const input = args.envelope.input as { videoId: number }
    return videoMutation(args, input.videoId, () => videoMaintenanceService.clearMetadata(input.videoId))
  },
  'videos.markScrapeSuccess'(args) {
    const input = args.envelope.input as { videoId: number }
    return videoMutation(args, input.videoId, () => videoMaintenanceService.markScrapeSucceeded(input.videoId))
  },
  'videos.deleteSample'(args) {
    const input = args.envelope.input as { videoId: number; assetId: number }
    return videoMutation(args, input.videoId, () =>
      videoMaintenanceService.deleteSample(input.videoId, input.assetId)
    )
  },
  'videos.addManualTag'(args) {
    const input = args.envelope.input as { videoId: number; name: string }
    return videoMutation(args, input.videoId, () => videoMaintenanceService.addManualTag(input.videoId, input.name))
  },
  'videos.addExistingManualTag'(args) {
    const input = args.envelope.input as { videoId: number; tagId: number }
    return videoMutation(args, input.videoId, () =>
      videoMaintenanceService.addExistingManualTag(input.videoId, input.tagId)
    )
  },
  'videos.removeManualTag'(args) {
    const input = args.envelope.input as { videoId: number; tagId: number }
    return videoMutation(args, input.videoId, () =>
      videoMaintenanceService.removeManualTag(input.videoId, input.tagId)
    )
  },
  'tags.list'() {
    return tagQueryService.list()
  },
  'tags.listManual'() {
    return tagQueryService.listManual()
  },
  'tags.labels'(args) {
    const input = args.envelope.input as { ids: number[] }
    return tagQueryService.labels(input.ids)
  },
  'tags.filterOptions'(args) {
    return tagQueryService.filterOptions(args.envelope.input as TagOptionsQuery)
  },
  'tags.manualOptions'(args) {
    return tagQueryService.manualOptions(args.envelope.input as TagOptionsQuery)
  },
  'actresses.list'(args) {
    const input = args.envelope.input as {
      search?: string
      gender?: ActressGenderFilter
      sortBy?: string
      sortDir?: SortDir
    }
    return actressQueryService.listLegacy(
      input.search,
      input.gender,
      input.sortBy as ActressListSortBy | undefined,
      input.sortDir
    )
  },
  'actresses.listPage'(args) {
    return actressQueryService.listActresses(args.envelope.input as ActressListQuery)
  },
  'actresses.pickerPage'(args) {
    return actressQueryService.listPicker(args.envelope.input as { search?: string; limit?: number; offset?: number })
  },
  'actresses.pickerGet'(args) {
    const input = args.envelope.input as { actressId: number }
    return actressQueryService.getPicker(input.actressId)
  },
  'actresses.testTargetPage'(args) {
    return actressQueryService.listTestTargets(
      args.envelope.input as { search?: string; limit?: number; offset?: number }
    )
  },
  'actresses.mergeCandidates'(args) {
    return actressQueryService.listMergeCandidates(
      args.envelope.input as { keepId: number; search?: string; limit?: number; offset?: number }
    )
  },
  'actresses.get'(args) {
    const input = args.envelope.input as { actressId: number }
    return actressQueryService.getActress(input.actressId)
  },
  'actresses.profile'(args) {
    const input = args.envelope.input as { actressId: number }
    return actressQueryService.getProfile(input.actressId)
  },
  'actresses.metadata'(args) {
    const input = args.envelope.input as { actressId: number }
    return actressQueryService.getMetadata(input.actressId)
  },
  'actresses.videoPage'(args) {
    const input = args.envelope.input as { actressId: number; limit?: number; offset?: number }
    return actressQueryService.listVideos(input.actressId, input)
  },
  'actresses.galleryPage'(args) {
    const input = args.envelope.input as { actressId: number; limit?: number; offset?: number }
    return actressQueryService.listGallery(input.actressId, input)
  },
  'actresses.avatarSourceInfo'(args) {
    const input = args.envelope.input as { actressId: number }
    return actressQueryService.getAvatarSourceInfo(input.actressId)
  },
  'actresses.deletePreview'(args) {
    const input = args.envelope.input as { ids: number[] }
    return actressMaintenanceService.previewDelete({ ids: input.ids })
  },
  'actresses.edit'(args) {
    const input = args.envelope.input as {
      actressId: number
      fields: ActressEditInput & { avatar?: CatalogImageRef }
    }
    const mutation = requireMutation(args.envelope)
    const { avatar, ...fields } = input.fields
    const apply = (): { ok: boolean; versions: { A: NonNullable<ReturnType<typeof readActressAggregateVersion>> } } => {
      assertExpectedActressVersion(
        input.actressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      if (avatar) {
        applyActressAvatarRef(
          input.actressId,
          avatar,
          mutation.expectedVersions,
          mutation.operationId,
          args.database
        )
      }
      const ok = actressMaintenanceService.editActress(input.actressId, fields)
      return {
        ok,
        versions: { A: readActressAggregateVersion(input.actressId, args.database)! }
      }
    }
    return avatar ? commitImage(args, apply) : commit(args, apply)
  },
  'actresses.delete'(args) {
    const input = args.envelope.input as {
      actressId: number
      mode: 'only-unlinked' | 'unlink-videos-and-delete'
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedActressVersion(
        input.actressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      return actressMaintenanceService.deleteActresses({ ids: [input.actressId], mode: input.mode })
    })
  },
  'actresses.deleteBatch'(args) {
    const input = args.envelope.input as {
      ids: number[]
      mode: 'only-unlinked' | 'unlink-videos-and-delete'
    }
    return commit(args, () => actressMaintenanceService.deleteActresses(input))
  },
  'actresses.clearMeta'(args) {
    const input = args.envelope.input as { actressId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedActressVersion(
        input.actressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = actressMaintenanceService.clearMetadata(input.actressId)
      return {
        ok,
        versions: { A: readActressAggregateVersion(input.actressId, args.database)! }
      }
    })
  },
  'actresses.merge'(args) {
    const input = args.envelope.input as { retainedActressId: number; sourceActressId: number; mainNameActressId?: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedActressVersion(
        input.retainedActressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = actressMaintenanceService.mergeActresses({
        keepId: input.retainedActressId,
        mergeId: input.sourceActressId,
        mainNameFrom: input.mainNameActressId === input.sourceActressId ? 'merge' : 'keep'
      })
      return {
        ok,
        versions: { A: readActressAggregateVersion(input.retainedActressId, args.database)! }
      }
    })
  },
  'actresses.markScrapeSuccess'(args) {
    const input = args.envelope.input as { actressId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedActressVersion(
        input.actressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = actressMaintenanceService.markScrapeSucceeded(input.actressId)
      return {
        ok,
        versions: { A: readActressAggregateVersion(input.actressId, args.database)! }
      }
    })
  },
  'actresses.deleteGallery'(args) {
    const input = args.envelope.input as { actressId: number; assetId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedActressVersion(
        input.actressId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = actressMaintenanceService.deleteGalleryImage(input.actressId, input.assetId)
      return {
        ok,
        versions: { A: readActressAggregateVersion(input.actressId, args.database)! }
      }
    })
  },
  'actressConflicts.list'() {
    return actressIdentityConflictWorkflow.listConflictGroups()
  },
  'actressConflicts.queuePage'(args) {
    return actressIdentityConflictWorkflow.pageConflictQueue(
      args.envelope.input as { limit?: number; offset?: number }
    )
  },
  'actressConflicts.get'(args) {
    const input = args.envelope.input as { pendingId: number }
    const row = catalogDb(args.database)
      .prepare(
        'SELECT normalized_name FROM pending_actress_scrape_conflicts WHERE pending_scrape_id = ? ORDER BY id LIMIT 1'
      )
      .get(input.pendingId) as { normalized_name: string } | undefined
    if (!row) return null
    return actressIdentityConflictWorkflow.getConflictGroup(row.normalized_name)
  },
  'actressConflicts.count'() {
    return actressIdentityConflictWorkflow.countPendingReviewItems()
  },
  'actressConflicts.summary'() {
    return actressIdentityConflictWorkflow.getConflictReviewSummary()
  },
  'organizations.list'(args) {
    return classificationQueryService.listOrganizations(
      args.envelope.input as { role: OrganizationRole; search?: string }
    )
  },
  'organizations.page'(args) {
    return classificationQueryService.listOrganizationsPage(
      args.envelope.input as { role: OrganizationRole; search?: string; limit?: number; offset?: number }
    )
  },
  'organizations.get'(args) {
    const input = args.envelope.input as { organizationId: number; role?: OrganizationRole }
    if (input.role) return classificationQueryService.getOrganization(input.organizationId, input.role)
    return (
      classificationQueryService.getOrganization(input.organizationId, 'maker') ??
      classificationQueryService.getOrganization(input.organizationId, 'publisher')
    )
  },
  'organizations.options'(args) {
    const input = args.envelope.input as { search?: string }
    return classificationQueryService.listOrganizationOptions(input.search)
  },
  'organizations.mergeOptions'(args) {
    const input = args.envelope.input as { organizationId: number; search?: string }
    return classificationQueryService
      .listOrganizationMergeOptions(input.search)
      .filter((row) => row.id !== input.organizationId)
  },
  'organizations.create'(args) {
    const input = args.envelope.input as OrganizationCreateInput
    return commit(args, () => {
      const id = classificationMaintenanceService.createOrganization(input)
      return {
        id,
        versions: { F: readClassificationAggregateVersion('organization', id, args.database)! }
      }
    })
  },
  'organizations.update'(args) {
    const input = args.envelope.input as { organizationId: number } & OrganizationUpdateInput
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'organization',
        input.organizationId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const { organizationId, ...fields } = input
      const ok = classificationMaintenanceService.updateOrganization(organizationId, fields)
      return {
        ok,
        versions: { F: readClassificationAggregateVersion('organization', organizationId, args.database)! }
      }
    })
  },
  'directors.list'(args) {
    return classificationQueryService.listDirectors(args.envelope.input as { search?: string })
  },
  'directors.page'(args) {
    return classificationQueryService.listDirectorsPage(
      args.envelope.input as { search?: string; limit?: number; offset?: number }
    )
  },
  'directors.get'(args) {
    const input = args.envelope.input as { directorId: number }
    return classificationQueryService.getDirector(input.directorId)
  },
  'directors.options'(args) {
    const input = args.envelope.input as { search?: string }
    return classificationQueryService.listDirectorOptions(input.search)
  },
  'directors.create'(args) {
    const input = args.envelope.input as DirectorProfileInput
    return commit(args, () => {
      const id = classificationMaintenanceService.createDirector(input)
      return {
        id,
        versions: { F: readClassificationAggregateVersion('director', id, args.database)! }
      }
    })
  },
  'directors.update'(args) {
    const input = args.envelope.input as { directorId: number } & DirectorProfileInput
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'director',
        input.directorId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const { directorId, ...fields } = input
      const ok = classificationMaintenanceService.updateDirector(directorId, fields)
      return {
        ok,
        versions: { F: readClassificationAggregateVersion('director', directorId, args.database)! }
      }
    })
  },
  'series.list'(args) {
    return classificationQueryService.listSeries(args.envelope.input as { search?: string })
  },
  'series.page'(args) {
    return classificationQueryService.listSeriesPage(
      args.envelope.input as { search?: string; limit?: number; offset?: number }
    )
  },
  'series.get'(args) {
    const input = args.envelope.input as { seriesId: number }
    return classificationQueryService.getSeries(input.seriesId)
  },
  'series.options'(args) {
    const input = args.envelope.input as { search?: string }
    return classificationQueryService.listSeriesOptions(input.search)
  },
  'series.create'(args) {
    const input = args.envelope.input as { mainName: string; organizationId?: number | null }
    return commit(args, () => {
      const profile: SeriesProfileInput = {
        mainName: input.mainName,
        ownerOrganizationId: input.organizationId ?? null
      }
      const id = classificationMaintenanceService.createSeries(profile)
      return {
        id,
        versions: { F: readClassificationAggregateVersion('series', id, args.database)! }
      }
    })
  },
  'series.update'(args) {
    const input = args.envelope.input as {
      seriesId: number
      mainName: string
      organizationId?: number | null
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedClassificationVersion(
        'series',
        input.seriesId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const fields: SeriesUpdateInput = {
        mainName: input.mainName,
        ownerOrganizationId: input.organizationId
      }
      const ok = classificationMaintenanceService.updateSeries(input.seriesId, fields)
      return {
        ok,
        versions: { F: readClassificationAggregateVersion('series', input.seriesId, args.database)! }
      }
    })
  },
  'classificationImages.page'(args) {
    const input = args.envelope.input as { entity: ClassificationEntityRef } & ClassificationPageQuery
    const { entity, ...query } = input
    return classificationQueryService.listImageCandidatesPage(entity, query)
  },
  'classificationImages.candidates'(args) {
    const input = args.envelope.input as { entity: ClassificationEntityRef }
    return classificationQueryService.listImageCandidates(input.entity)
  },
  'playlists.list'() {
    return listPlaylists()
  },
  'playlists.listPage'(args) {
    return listPlaylistBrowsePage(args.envelope.input as PlaylistListQuery, catalogDb(args.database))
  },
  'playlists.get'(args) {
    const input = args.envelope.input as { playlistId: number }
    return getPlaylistDetail(input.playlistId)
  },
  'playlists.getPage'(args) {
    const input = args.envelope.input as { playlistId: number } & PlaylistPageQuery
    return getPlaylistPage(input.playlistId, input)
  },
  'playlists.metadata'(args) {
    const input = args.envelope.input as { playlistId: number }
    return getPlaylistMetadata(input.playlistId)
  },
  'playlists.videoPage'(args) {
    const input = args.envelope.input as { playlistId: number } & PlaylistPageQuery
    return listPlaylistVideoPage(input.playlistId, input)
  },
  'playlists.listForVideo'(args) {
    const input = args.envelope.input as { videoId: number }
    return listPlaylistsForVideo(input.videoId)
  },
  'playlists.delete'(args) {
    const input = args.envelope.input as { playlistId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedPlaylistVersion(
        input.playlistId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      deletePlaylist(input.playlistId)
      return { ok: true }
    })
  },
  'playlists.addVideo'(args) {
    const input = args.envelope.input as { playlistId: number; videoId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedPlaylistVersion(
        input.playlistId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = addVideoToPlaylist(input)
      return {
        ok,
        versions: { P: readPlaylistAggregateVersion(input.playlistId, args.database)! }
      }
    })
  },
  'playlists.removeVideo'(args) {
    const input = args.envelope.input as { playlistId: number; videoId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () => {
      assertExpectedPlaylistVersion(
        input.playlistId,
        mutation.expectedVersions,
        mutation.operationId,
        args.database
      )
      const ok = removeVideoFromPlaylist(input)
      return {
        ok,
        versions: { P: readPlaylistAggregateVersion(input.playlistId, args.database)! }
      }
    })
  },
  'libraries.get'(args) {
    const input = args.envelope.input as { libraryId: number }
    return getMediaLibraryDetail(input.libraryId)
  },
  'libraries.create'(args) {
    const input = args.envelope.input as CreateMediaLibraryInput
    return commit(args, () => runLibrary(() => mediaLibraries.create(input)))
  },
  'libraries.update'(args) {
    const input = args.envelope.input as {
      libraryId: number
      name?: string
      icon?: MediaLibraryPatch['icon']
      color?: MediaLibraryPatch['color']
      position?: number
    }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runLibrary(() =>
        mediaLibraries.update({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId),
          patch: {
            name: input.name,
            icon: input.icon,
            color: input.color,
            position: input.position
          }
        })
      )
    )
  },
  'libraries.updateConfig'(args) {
    const input = args.envelope.input as { libraryId: number; patch: MediaLibraryConfigPatch }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runLibrary(() =>
        mediaLibraries.updateConfig({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'C', mutation.operationId),
          patch: input.patch
        })
      )
    )
  },
  'libraries.archive'(args) {
    const input = args.envelope.input as { libraryId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runLibrary(() =>
        mediaLibraries.archive({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId)
        })
      )
    )
  },
  'libraries.restore'(args) {
    const input = args.envelope.input as { libraryId: number }
    const mutation = requireMutation(args.envelope)
    return commit(args, () =>
      runLibrary(() =>
        mediaLibraries.restore({
          libraryId: input.libraryId,
          expectedRevision: requireLibraryRevision(mutation.expectedVersions, 'L', mutation.operationId)
        })
      )
    )
  },
  'libraries.deletePreview'(args) {
    const input = args.envelope.input as { libraryId: number }
    return runLibrary(() => mediaLibraries.previewRemoval(input.libraryId))
  },
  'browser.status'() {
    return requireManageBrowserSurface().status()
  },
  'browser.setEnabled'(args) {
    const input = args.envelope.input as { enabled: boolean }
    return commit(args, () => requireManageBrowserSurface().setEnabled(input.enabled))
  },
  'browser.pairOpen'(args) {
    return commit(args, () => requireManageBrowserSurface().pairOpen())
  },
  'browser.pairInspect'(args) {
    const input = args.envelope.input as { code: string }
    return requireManageBrowserSurface().pairInspect(input.code)
  },
  'browser.pairDecide'(args) {
    const input = args.envelope.input as { code: string; decision: 'approve' | 'deny' }
    return commit(args, () =>
      requireManageBrowserSurface().pairDecide(input.code, input.decision === 'approve')
    )
  },
  'browser.deviceRemove'(args) {
    const input = args.envelope.input as { deviceId: string }
    return commit(args, () => requireManageBrowserSurface().deviceRemove(input.deviceId))
  },
  'browser.deviceRename'(args) {
    const input = args.envelope.input as { deviceId: string; name: string }
    return commit(args, () => requireManageBrowserSurface().deviceRename(input.deviceId, input.name))
  },
  'browser.deviceReset'(args) {
    const input = args.envelope.input as { deviceId: string }
    return commit(args, () => requireManageBrowserSurface().deviceReset(input.deviceId))
  },
  'browser.revokeSessions'(args) {
    return commit(args, () => requireManageBrowserSurface().revokeSessions())
  },
  ...remainderHandlers,
  ...maintenanceHandlers
}

export function dispatchCatalogManage(
  operation: ManageOperationId,
  envelope: ManageEnvelope,
  auth: { epoch: number },
  database?: Database.Database
): unknown | typeof CATALOG_NOT_HANDLED {
  const handler = handlers[operation]
  if (!handler) return CATALOG_NOT_HANDLED
  return handler({ operation, envelope, auth, database })
}
