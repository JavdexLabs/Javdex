import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { structuredError } from '@shared/protocol/errors'
import type { DesktopSession } from '@shared/desktop/session'
import type { CatalogIdentity } from '@shared/protocol/identity'
import type {
  ActressEditInput,
  ActressGalleryImportInput,
  ActressMergeInput
} from '@shared/actressTypes'
import type { ActressDeleteRequest } from '@shared/actressIpcContract'
import type {
  ClassificationEntityRef,
  ClassificationImageInput,
  DirectorProfileInput,
  OrganizationCreateInput,
  OrganizationRole,
  OrganizationUpdateInput,
  SeriesProfileInput
} from '@shared/classificationTypes'
import type {
  AddMediaLibraryRootInput,
  UpdateMediaLibraryConfigInput,
  UpdateMediaLibraryInput,
  UpdateMediaLibraryRootInput
} from '@shared/mediaLibraryIpcContract'
import type { CreateMediaLibraryInput } from '@shared/mediaLibraryTypes'
import type {
  PlaylistCreateInput,
  PlaylistListQuery,
  PlaylistPageQuery,
  PlaylistUpdateInput,
  PlaylistVideoSortBy
} from '@shared/playlistTypes'
import type { SortDir } from '@shared/commonTypes'
import type {
  LastVideoResourceRemovalMode,
  VideoEditInput,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoMergeInput,
  VideoSampleImportInput
} from '@shared/videoTypes'
import type {
  DeleteVideoGloballyInput,
  MoveVideoResourceInput,
  RemoveVideoFromLibraryInput
} from '@shared/videoLifecycleTypes'
import type {
  CatalogActressCommands,
  CatalogBackend,
  CatalogClassificationCommands,
  CatalogLibraryCommands,
  CatalogPlaylistCommands,
  CatalogQueries,
  CatalogQueryContext,
  CatalogVideoCommands,
  MutationContext
} from '../../application/catalogBackend'
import { createLocalDesktopCapabilities } from '../../application/desktopCapabilities'
import { createUnconfiguredRemoteBackend } from '../remote/unconfiguredRemoteBackend'
import type { VideoMaintenanceService } from '../../services/videoMaintenanceService'
import {
  createVideoQueryService,
  type AsyncVideoQueryService,
  type VideoQueryService
} from '../../services/videoQueryService'
import { videoMaintenanceService } from '../../services/videoMaintenanceService'
import { videoLifecycleService } from '../../services/videoLifecycleService'
import type { VideoLifecycleService } from '../../services/videoLifecycleService'
import { actressQueryService, type ActressQueryService } from '../../services/actressQueryService'
import { actressMaintenanceService } from '../../services/actressMaintenanceService'
import { actressIdentityConflictWorkflow } from '../../services/actressIdentityConflictWorkflow'
import { classificationQueryService } from '../../services/classificationQueryService'
import { classificationMaintenanceService } from '../../services/classificationMaintenanceService'
import { classificationImageService } from '../../services/classificationImageService'
import { organizationMergeService } from '../../services/organizationMergeService'
import { directorMergeService } from '../../services/directorMergeService'
import { seriesMergeService } from '../../services/seriesMergeService'
import { organizationDeletionService } from '../../services/organizationDeletionService'
import { classificationDeletionService } from '../../services/classificationDeletionService'
import { tagQueryService } from '../../services/tagQueryService'
import { createPlaylist, deletePlaylist, updatePlaylist } from '../../services/playlistService'
import {
  createMediaLibraryService,
  createMediaLibraryServiceDependencies
} from '@library/catalog/mediaLibraryService'
import { homeDiscoveryRepo } from '@library/db/homeDiscoveryRepo'
import { getLibraryOverviewStats } from '@library/db/overviewRepo'
import { getMediaLibraryDetail, listMediaLibraries } from '@library/db/mediaLibraryRepo'
import { listPlaylistBrowsePage } from '@library/db/playlistListPageRepo'
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
import type { HomeDiscoveryInput, GlobalSearchInput } from '@shared/catalogTypes'
import type { TagOptionsQuery } from '@shared/commonTypes'
import type { ClassificationPageQuery } from '@shared/classificationTypes'
import type { DiscardPendingActressScrapeInput, InspectActressConflictNameInput, ResolveActressConflictInput, ValidateIllegalNameReplacementsInput } from '@shared/actressConflictTypes'

export async function unsupportedCatalogUseCase(name: string): Promise<never> {
  throw structuredError('UNSUPPORTED_CAPABILITY', `本地后端尚未接入该用例：${name}`)
}

export function unsupportedSlice<T extends object>(keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, () => unsupportedCatalogUseCase(String(key))])) as T
}

function toVideoEditInput(
  fields: {
    title?: string | null
    summary?: string | null
    release_date?: string | null
    makerOrganization?: VideoEditInput['makerOrganization']
    publisherOrganization?: VideoEditInput['publisherOrganization']
    directorAssignment?: VideoEditInput['directorAssignment']
    seriesAssignment?: VideoEditInput['seriesAssignment']
    duration_seconds?: number | null
    rating?: number
    tags?: string[]
    actressesFemale?: string[]
    actressesMale?: string[]
    cover?: { kind: string }
    coverSourcePath?: string
    links?: VideoEditInput['links']
  }
): VideoEditInput {
  if (fields.cover && fields.cover.kind === 'upload') {
    throw structuredError(
      'UNSUPPORTED_CAPABILITY',
      '本地影片编辑暂不通过上传引用改封面；请使用现有封面导入入口。'
    )
  }
  const input: VideoEditInput = {}
  if ('title' in fields) input.title = fields.title
  if ('summary' in fields) input.summary = fields.summary
  if ('release_date' in fields) input.release_date = fields.release_date
  if ('makerOrganization' in fields) input.makerOrganization = fields.makerOrganization
  if ('publisherOrganization' in fields) input.publisherOrganization = fields.publisherOrganization
  if ('directorAssignment' in fields) input.directorAssignment = fields.directorAssignment
  if ('seriesAssignment' in fields) input.seriesAssignment = fields.seriesAssignment
  if ('duration_seconds' in fields) input.duration_seconds = fields.duration_seconds
  if ('rating' in fields) input.rating = fields.rating
  if ('tags' in fields) input.tags = fields.tags
  if ('actressesFemale' in fields) input.actressesFemale = fields.actressesFemale
  if ('actressesMale' in fields) input.actressesMale = fields.actressesMale
  if ('links' in fields) input.links = fields.links
  if ('coverSourcePath' in fields) input.coverSourcePath = fields.coverSourcePath
  return input
}

export interface LocalCatalogReadPort {
  homeLoad(input: HomeDiscoveryInput): unknown | Promise<unknown>
  homeSearch(input: GlobalSearchInput): unknown | Promise<unknown>
  tagFilterOptions(query: TagOptionsQuery): unknown | Promise<unknown>
  imagePage(entity: ClassificationEntityRef, query?: ClassificationPageQuery): unknown | Promise<unknown>
}

export interface LocalCatalogBackendDependencies {
  identity: CatalogIdentity
  generation?: number
  appVersion?: string
  queries?: VideoQueryService | AsyncVideoQueryService
  videos?: VideoMaintenanceService
  lifecycle?: VideoLifecycleService
  actresses?: ActressQueryService
  reads?: LocalCatalogReadPort
  libraries?: ReturnType<typeof createMediaLibraryService>
}

const defaultLibraries = (): ReturnType<typeof createMediaLibraryService> =>
  createMediaLibraryService(
    createMediaLibraryServiceDependencies({
      isVideoScraperRunnable: () => true
    })
  )

const defaultReads: LocalCatalogReadPort = {
  homeLoad: (input) => homeDiscoveryRepo.load(input),
  homeSearch: (input) => homeDiscoveryRepo.search(input),
  tagFilterOptions: (query) => tagQueryService.filterOptions(query),
  imagePage: (entity, query) => classificationQueryService.listImageCandidatesPage(entity, query)
}

export function createLocalCatalogBackend(
  dependencies: LocalCatalogBackendDependencies
): CatalogBackend {
  if (dependencies.identity.mode !== 'local') {
    throw new Error('LocalCatalogBackend requires a local catalog identity')
  }
  const queries = dependencies.queries ?? createVideoQueryService()
  const videos = dependencies.videos ?? videoMaintenanceService
  const lifecycle = dependencies.lifecycle ?? videoLifecycleService
  const actresses = dependencies.actresses ?? actressQueryService
  const reads = dependencies.reads ?? defaultReads
  const libraries = dependencies.libraries ?? defaultLibraries()
  const generation = dependencies.generation ?? 1
  const identity = dependencies.identity
  const session = (): DesktopSession => ({
    state: 'available',
    mode: 'local',
    catalogId: identity.catalogId,
    serverId: null,
    generation,
    writerEpoch: null,
    frozen: false,
    appVersion: dependencies.appVersion ?? null,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    message: null
  })

  const catalogQueries: CatalogQueries = {
    async homeLoad(input) {
      return reads.homeLoad(input)
    },
    async homeSearch(input) {
      return reads.homeSearch(input)
    },
    async listVideos(input, _ctx?: CatalogQueryContext) {
      return queries.list(input.scope, input.query)
    },
    async getVideo(input) {
      return queries.get(input.scope, input.videoId)
    },
    async listVideoYears(input) {
      return queries.listYears(input.scope)
    },
    async getResource(input) {
      return queries.getResource(input.libraryId, input.videoId, input.resourceId)
    },
    async listTags() {
      return tagQueryService.list()
    },
    async listManualTags() {
      return tagQueryService.listManual()
    },
    async tagLabels(input) {
      return tagQueryService.labels(input.ids)
    },
    async tagFilterOptions(input) {
      return reads.tagFilterOptions(input)
    },
    async tagManualOptions(input) {
      return tagQueryService.manualOptions(input)
    },
    async overviewStats() {
      return getLibraryOverviewStats()
    }
  }

  const videoCommands: CatalogVideoCommands = {
    async edit(input, _ctx: MutationContext) {
      return videos.edit(input.videoId, toVideoEditInput(input.fields))
    },
    async clearMeta(input) {
      return videos.clearMetadata(input.videoId)
    },
    async markScrapeSuccess(input) {
      return videos.markScrapeSucceeded(input.videoId)
    },
    async setRating(input) {
      return videos.setRating(input.videoId, input.rating)
    },
    async setPoster(input, _ctx: MutationContext) {
      if (input.image.kind === 'clear') return videos.setPoster(input.videoId, null)
      const localPath = (input as { posterPath?: string | null }).posterPath
      if (typeof localPath === 'string' || localPath === null) {
        return videos.setPoster(input.videoId, localPath)
      }
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '本地影片封面仍使用本机文件入口；上传引用等 S06。'
      )
    },
    async importSamples(input, _ctx: MutationContext) {
      const sample = input as { videoId: number } & VideoSampleImportInput
      if (sample.source === 'file' || sample.source === 'url') {
        return videos.importSample(sample.videoId, sample)
      }
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '本地样张导入仍使用本机文件入口；上传引用等 S06。'
      )
    },
    async deleteSample(input) {
      return videos.deleteSample(input.videoId, input.assetId)
    },
    async addManualTag(input) {
      return videos.addManualTag(input.videoId, input.name)
    },
    async addExistingManualTag(input) {
      return videos.addExistingManualTag(input.videoId, input.tagId)
    },
    async removeManualTag(input) {
      return videos.removeManualTag(input.videoId, input.tagId)
    },
    async correctImport(input) {
      return videos.correctImport(input.videoId, input.code, input.discardPendingScrape)
    },
    async importResource(input) {
      return videos.importLinkResource(input as VideoLinkResourceImportInput)
    },
    async updateResource(input) {
      return videos.updateLinkResource(
        input.libraryId,
        input.videoId,
        input.resourceId,
        {
          url: input.url,
          kind: input.kind,
          displayName: input.displayName,
          sizeBytes: input.sizeBytes
        } satisfies VideoLinkResourceUpdateInput
      )
    },
    async updateLocalResourceLabel(input) {
      return videos.updateLocalResourceLabel(
        input.libraryId,
        input.videoId,
        input.resourceId,
        input.label
      )
    },
    async setPrimaryResource(input) {
      return videos.setPrimaryResource(input.libraryId, input.videoId, input.resourceId)
    },
    async removeResource(input) {
      return videos.removeResource(
        input.libraryId,
        input.videoId,
        input.resourceId,
        input.lastResourceMode as LastVideoResourceRemovalMode | undefined
      )
    },
    async previewRemoveFromLibrary(input) {
      return lifecycle.previewRemoveFromLibrary(input.libraryId, input.videoId)
    },
    async removeFromLibrary(input, ctx) {
      const local = input as RemoveVideoFromLibraryInput & { planDigest?: string }
      return lifecycle.removeFromLibrary({
        libraryId: local.libraryId,
        videoId: local.videoId,
        operationId: local.operationId ?? ctx.operationId,
        expectedRevision: local.expectedRevision ?? local.planDigest ?? ''
      })
    },
    async previewMoveResource(input) {
      return lifecycle.previewMoveResource(
        input.sourceLibraryId,
        input.targetLibraryId,
        input.resourceId
      )
    },
    async moveResource(input, ctx) {
      const local = input as MoveVideoResourceInput & { planDigest?: string }
      return lifecycle.moveResource({
        sourceLibraryId: local.sourceLibraryId,
        targetLibraryId: local.targetLibraryId,
        resourceId: local.resourceId,
        operationId: local.operationId ?? ctx.operationId,
        expectedRevision: local.expectedRevision ?? local.planDigest ?? ''
      })
    },
    async previewDeleteGlobal(input) {
      return lifecycle.previewDeleteGlobally(input.videoId)
    },
    async deleteGlobal(input, ctx) {
      const local = input as DeleteVideoGloballyInput & { planDigest?: string }
      return lifecycle.deleteGlobally({
        videoId: local.videoId,
        operationId: local.operationId ?? ctx.operationId,
        expectedRevision: local.expectedRevision ?? local.planDigest ?? ''
      })
    },
    async merge(input) {
      return videos.mergeVideos(input as VideoMergeInput)
    },
    async splitResource(input) {
      return videos.splitResource(input.libraryId, input.videoId, input.resourceId)
    },
    applyScrapeCandidate: () => unsupportedCatalogUseCase('videos.applyScrapeCandidate')
  }

  const actressCommands: CatalogActressCommands = {
    async list(input) {
      return actresses.listLegacy(
        input.search,
        input.gender,
        input.sortBy as never,
        input.sortDir
      )
    },
    async listPage(input) {
      return actresses.listActresses(input)
    },
    async pickerPage(input) {
      return actresses.listPicker(input)
    },
    async pickerGet(input) {
      return actresses.getPicker(input.actressId)
    },
    async testTargetPage(input) {
      return actresses.listTestTargets(input)
    },
    async get(input) {
      return actresses.getActress(input.actressId)
    },
    async profile(input) {
      return actresses.getProfile(input.actressId)
    },
    async metadata(input) {
      return actresses.getMetadata(input.actressId)
    },
    async videoPage(input) {
      return actresses.listVideos(input.actressId, input)
    },
    async galleryPage(input) {
      return actresses.listGallery(input.actressId, input)
    },
    async avatarSourceInfo(input) {
      return actresses.getAvatarSourceInfo(input.actressId)
    },
    async mergeCandidates(input) {
      return actresses.listMergeCandidates(input)
    },
    async edit(input) {
      return actressMaintenanceService.editActress(
        input.actressId,
        input.fields as ActressEditInput
      )
    },
    async delete(input, ctx) {
      return actressCommands.deleteBatch(
        { ids: [input.actressId], mode: input.mode },
        ctx
      )
    },
    async deleteBatch(input) {
      return actressMaintenanceService.deleteActresses(input as ActressDeleteRequest)
    },
    async deletePreview(input) {
      return actressMaintenanceService.previewDelete({ ids: input.ids })
    },
    async clearMeta(input) {
      return actressMaintenanceService.clearMetadata(input.actressId)
    },
    async importGallery(input) {
      const local = input as { actressId: number } & ActressGalleryImportInput
      if (local.source === 'file' || local.source === 'url') {
        return actressMaintenanceService.importGalleryImage(local.actressId, local)
      }
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '本地演员图库仍使用本机文件入口；上传引用等 S06。'
      )
    },
    async deleteGallery(input) {
      return actressMaintenanceService.deleteGalleryImage(input.actressId, input.assetId)
    },
    async setPoster(input) {
      if (input.image.kind === 'clear') {
        return actressMaintenanceService.setPoster(input.actressId, null)
      }
      const localPath = (input as { posterPath?: string | null }).posterPath
      if (typeof localPath === 'string' || localPath === null) {
        return actressMaintenanceService.setPoster(input.actressId, localPath)
      }
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '本地演员头像仍使用本机文件入口；上传引用等 S06。'
      )
    },
    async merge(input) {
      const local = input as ActressMergeInput & {
        retainedActressId?: number
        sourceActressId?: number
        mainNameActressId?: number
      }
      if (local.keepId && local.mergeId) {
        return actressMaintenanceService.mergeActresses(local)
      }
      return actressMaintenanceService.mergeActresses({
        keepId: local.retainedActressId!,
        mergeId: local.sourceActressId!,
        mainNameFrom: local.mainNameActressId === local.sourceActressId ? 'merge' : 'keep'
      })
    },
    async markScrapeSuccess(input) {
      return actressMaintenanceService.markScrapeSucceeded(input.actressId)
    },
    applyCrop: () => unsupportedCatalogUseCase('actresses.applyCrop'),
    applyScrapeCandidate: () => unsupportedCatalogUseCase('actresses.applyScrapeCandidate'),
    async conflictList() {
      return actressIdentityConflictWorkflow.listConflictGroups()
    },
    async conflictQueuePage(input) {
      return actressIdentityConflictWorkflow.pageConflictQueue(input)
    },
    async conflictGet(input) {
      const local = input as { pendingId: number; normalizedName?: string }
      if (local.normalizedName) {
        return actressIdentityConflictWorkflow.getConflictGroup(local.normalizedName)
      }
      throw structuredError(
        'INVALID_INPUT',
        '本地演员冲突详情仍按规范化名查询；pendingId 投影在 S08 完成。'
      )
    },
    async conflictCount() {
      return actressIdentityConflictWorkflow.countPendingReviewItems()
    },
    async conflictSummary() {
      return actressIdentityConflictWorkflow.getConflictReviewSummary()
    },
    async inspectName(input) {
      return actressIdentityConflictWorkflow.inspectConflictName(
        input as InspectActressConflictNameInput
      )
    },
    async discardConflict(input) {
      return actressIdentityConflictWorkflow.discardPendingScrape(
        input as DiscardPendingActressScrapeInput
      )
    },
    async validateIllegal(input) {
      return actressIdentityConflictWorkflow.validateIllegalNameReplacements(
        input as ValidateIllegalNameReplacementsInput
      )
    },
    async resolveConflict(input) {
      return actressIdentityConflictWorkflow.resolveConflict(input as ResolveActressConflictInput)
    }
  }

  const classificationCommands: CatalogClassificationCommands = {
    async listOrganizations(input) {
      return classificationQueryService.listOrganizations(input)
    },
    async pageOrganizations(input) {
      return classificationQueryService.listOrganizationsPage(input)
    },
    async getOrganization(input) {
      const role = (input as { role?: OrganizationRole }).role
      if (role) return classificationQueryService.getOrganization(input.organizationId, role)
      return (
        classificationQueryService.getOrganization(input.organizationId, 'maker') ??
        classificationQueryService.getOrganization(input.organizationId, 'publisher')
      )
    },
    async createOrganization(input) {
      return classificationMaintenanceService.createOrganization(input as OrganizationCreateInput)
    },
    async updateOrganization(input) {
      const { organizationId, ...fields } = input
      return classificationMaintenanceService.updateOrganization(
        organizationId,
        fields as OrganizationUpdateInput
      )
    },
    async mergeOrganizations(input) {
      return organizationMergeService.merge(input)
    },
    async deleteOrganization(input) {
      return organizationDeletionService.deleteOrganization(input.organizationId)
    },
    async organizationOptions(input) {
      return classificationQueryService.listOrganizationOptions(input.search)
    },
    async organizationMergeOptions(input) {
      return classificationQueryService.listOrganizationMergeOptions(input.search)
    },
    async organizationRoleRemovePreview(input) {
      return organizationDeletionService.previewRoleRemoval(input.organizationId, input.role)
    },
    async organizationRoleRemove(input) {
      return organizationDeletionService.removeRole(input.organizationId, input.role)
    },
    async organizationDeletePreview(input) {
      return organizationDeletionService.previewOrganization(input.organizationId)
    },
    async listDirectors(input) {
      return classificationQueryService.listDirectors(input)
    },
    async pageDirectors(input) {
      return classificationQueryService.listDirectorsPage(input)
    },
    async getDirector(input) {
      return classificationQueryService.getDirector(input.directorId)
    },
    async createDirector(input) {
      return classificationMaintenanceService.createDirector(input as DirectorProfileInput)
    },
    async updateDirector(input) {
      const { directorId, ...fields } = input
      return classificationMaintenanceService.updateDirector(directorId, fields)
    },
    async mergeDirectors(input) {
      return directorMergeService.merge(input)
    },
    async deleteDirector(input) {
      return classificationDeletionService.deleteDirector(input.directorId)
    },
    async directorOptions(input) {
      return classificationQueryService.listDirectorOptions(input.search)
    },
    async directorDeletePreview(input) {
      return classificationDeletionService.previewDirector(input.directorId)
    },
    async listSeries(input) {
      return classificationQueryService.listSeries(input)
    },
    async pageSeries(input) {
      return classificationQueryService.listSeriesPage(input)
    },
    async getSeries(input) {
      return classificationQueryService.getSeries(input.seriesId)
    },
    async createSeries(input) {
      return classificationMaintenanceService.createSeries(input as SeriesProfileInput)
    },
    async updateSeries(input) {
      const { seriesId, ...fields } = input
      return classificationMaintenanceService.updateSeries(seriesId, fields)
    },
    async mergeSeries(input) {
      return seriesMergeService.merge(input)
    },
    async deleteSeries(input) {
      return classificationDeletionService.deleteSeries(input.seriesId)
    },
    async seriesOptions(input) {
      return classificationQueryService.listSeriesOptions(input.search)
    },
    async seriesDeletePreview(input) {
      return classificationDeletionService.previewSeries(input.seriesId)
    },
    async imagePage(input) {
      const { entity, ...query } = input as {
        entity: ClassificationEntityRef
      } & ClassificationPageQuery
      return reads.imagePage(entity, query)
    },
    async imageCandidates(input) {
      return classificationQueryService.listImageCandidates(input.entity)
    },
    async setImage(input) {
      const image = input.image as ClassificationImageInput | { kind?: string; videoId?: number }
      if (image && 'source' in image) {
        return classificationImageService.setImage(input.entity, image)
      }
      if (image && 'kind' in image && image.kind === 'videoCover' && image.videoId) {
        return classificationImageService.setImage(input.entity, {
          source: 'video-cover',
          videoId: image.videoId
        })
      }
      if (image && 'kind' in image && image.kind === 'clear') {
        return classificationImageService.setImage(input.entity, null)
      }
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '本地分类图片仍使用本机文件入口；上传引用等 S06。'
      )
    }
  }

  const playlistCommands: CatalogPlaylistCommands = {
    async list() {
      return listPlaylists()
    },
    async listPage(input) {
      return listPlaylistBrowsePage(input as PlaylistListQuery)
    },
    async get(input) {
      const local = input as {
        playlistId: number
        sortBy?: PlaylistVideoSortBy
        sortDir?: SortDir
      }
      return getPlaylistDetail(local.playlistId, {
        sortBy: local.sortBy,
        sortDir: local.sortDir
      })
    },
    async getPage(input) {
      return getPlaylistPage(input.playlistId, input as PlaylistPageQuery)
    },
    async metadata(input) {
      const local = input as {
        playlistId: number
        sortBy?: PlaylistVideoSortBy
        sortDir?: SortDir
      }
      return getPlaylistMetadata(local.playlistId, {
        sortBy: local.sortBy,
        sortDir: local.sortDir
      })
    },
    async videoPage(input) {
      return listPlaylistVideoPage(input.playlistId, input as PlaylistPageQuery)
    },
    async listForVideo(input) {
      return listPlaylistsForVideo(input.videoId)
    },
    async create(input) {
      return createPlaylist(input as PlaylistCreateInput)
    },
    async update(input) {
      const { playlistId, ...fields } = input
      updatePlaylist(playlistId, fields as PlaylistUpdateInput)
      return true
    },
    async delete(input) {
      deletePlaylist(input.playlistId)
      return true
    },
    async addVideo(input) {
      return addVideoToPlaylist(input)
    },
    async removeVideo(input) {
      return removeVideoFromPlaylist(input)
    },
    applyImport: () => unsupportedCatalogUseCase('playlists.applyImport')
  }

  const libraryCommands: CatalogLibraryCommands = {
    async list(input) {
      return listMediaLibraries({ includeArchived: input.includeArchived })
    },
    async get(input) {
      return getMediaLibraryDetail(input.libraryId)
    },
    async create(input) {
      return libraries.create(input as CreateMediaLibraryInput)
    },
    async update(input) {
      const local = input as UpdateMediaLibraryInput
      if (local.patch && local.expectedRevision !== undefined) {
        return libraries.update({
          libraryId: local.libraryId,
          expectedRevision: local.expectedRevision,
          patch: local.patch
        })
      }
      return libraries.update({
        libraryId: input.libraryId,
        expectedRevision: (input as { expectedRevision?: number }).expectedRevision ?? 0,
        patch: {
          name: input.name,
          icon: input.icon as CreateMediaLibraryInput['icon'],
          color: input.color as CreateMediaLibraryInput['color'],
          position: input.position
        }
      })
    },
    async updateConfig(input) {
      const local = input as UpdateMediaLibraryConfigInput
      return libraries.updateConfig({
        libraryId: local.libraryId,
        expectedRevision: local.expectedRevision,
        patch: local.patch
      })
    },
    async addRoot(input) {
      const local = input as AddMediaLibraryRootInput & { root: { path?: string } }
      if (!local.root.path) {
        throw structuredError(
          'UNSUPPORTED_CAPABILITY',
          '本地添加根目录仍使用本机路径，不使用 mountSelectionId。'
        )
      }
      return libraries.addRoot({
        libraryId: local.libraryId,
        expectedRevision: local.expectedRevision,
        root: local.root
      })
    },
    async updateRoot(input) {
      const local = input as UpdateMediaLibraryRootInput
      return libraries.updateRoot({
        libraryId: local.libraryId,
        rootId: local.rootId,
        expectedRevision: local.expectedRevision,
        patch: local.patch
      })
    },
    async removeRoot(input) {
      return libraries.removeRoot(input as never)
    },
    async cancelRootRemoval(input) {
      return libraries.cancelRootRemoval(input as never)
    },
    async archive(input) {
      return libraries.archive(input as never)
    },
    async restore(input) {
      return libraries.restore(input as never)
    },
    async deletePreview(input) {
      return libraries.previewRemoval(input.libraryId)
    },
    async delete(input) {
      return libraries.remove(input as never)
    },
    runScan: () => unsupportedCatalogUseCase('scans.run'),
    cancelScan: () => unsupportedCatalogUseCase('scans.cancel'),
    latestScan: () => unsupportedCatalogUseCase('scans.getLatest'),
    renameFile: () => unsupportedCatalogUseCase('files.rename'),
    importManual: () => unsupportedCatalogUseCase('files.importManual'),
    resolvePendingScan: () => unsupportedCatalogUseCase('pendingScan.resolve'),
    resolveResourceIdentity: () => unsupportedCatalogUseCase('pendingResourceIdentity.resolve')
  }

  return {
    mode: 'local',
    identity,
    generation,
    capabilities: createLocalDesktopCapabilities,
    session,
    queries: catalogQueries,
    videos: videoCommands,
    actresses: actressCommands,
    classifications: classificationCommands,
    playlists: playlistCommands,
    libraries: libraryCommands,
    nfo: unsupportedSlice([
      'getOptions',
      'updatePreferences',
      'plan',
      'discardPlan',
      'start',
      'terminate',
      'state'
    ]),
    browser: unsupportedSlice([
      'status',
      'setEnabled',
      'pairOpen',
      'pairInspect',
      'pairDecide',
      'deviceRemove',
      'deviceRename',
      'deviceReset',
      'revokeSessions'
    ]),
    tasks: unsupportedSlice([
      'get',
      'list',
      'cancel',
      'getOperation',
      'createTargetList',
      'pageTargetList'
    ]),
    assets: unsupportedSlice(['createUpload', 'inspectUpload', 'grantPlayback']),
    migration: unsupportedSlice(['preview', 'start', 'status', 'allowEnable', 'enable', 'abandon']),
    async dispose(): Promise<void> {
      return
    }
  }
}

export function createCatalogBackendForMode(
  mode: 'local' | 'remote',
  local: LocalCatalogBackendDependencies
): CatalogBackend {
  if (mode === 'remote') return createUnconfiguredRemoteBackend()
  return createLocalCatalogBackend(local)
}
