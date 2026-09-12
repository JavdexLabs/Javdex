import { CURRENT_SCHEMA_VERSION } from '@library/db/migrations'
import { structuredError } from '@shared/protocol/errors'
import type { DesktopSession } from '@shared/desktop/session'
import type { CatalogIdentity } from '@shared/protocol/identity'
import type { VideoEditInput } from '@shared/videoTypes'
import type {
  CatalogBackend,
  CatalogQueryContext,
  MutationContext
} from '../../application/catalogBackend'
import { createLocalDesktopCapabilities } from '../../application/desktopCapabilities'
import { createUnconfiguredRemoteBackend } from '../remote/unconfiguredRemoteBackend'
import type { VideoMaintenanceService } from '../../services/videoMaintenanceService'
import {
  createVideoQueryService,
  type VideoQueryService
} from '../../services/videoQueryService'
import { videoMaintenanceService } from '../../services/videoMaintenanceService'

async function unsupported(name: string): Promise<never> {
  throw structuredError('UNSUPPORTED_CAPABILITY', `本地后端尚未接入该用例：${name}`)
}

function unsupportedSlice<T extends object>(keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, () => unsupported(String(key))])) as T
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
    links?: VideoEditInput['links']
  }
): VideoEditInput {
  if (fields.cover) {
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
  return input
}

export interface LocalCatalogBackendDependencies {
  identity: CatalogIdentity
  generation?: number
  appVersion?: string
  queries?: VideoQueryService
  videos?: VideoMaintenanceService
}

export function createLocalCatalogBackend(
  dependencies: LocalCatalogBackendDependencies
): CatalogBackend {
  if (dependencies.identity.mode !== 'local') {
    throw new Error('LocalCatalogBackend requires a local catalog identity')
  }
  const queries = dependencies.queries ?? createVideoQueryService()
  const videos = dependencies.videos ?? videoMaintenanceService
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

  return {
    mode: 'local',
    identity,
    generation,
    capabilities: createLocalDesktopCapabilities,
    session,
    queries: {
      ...unsupportedSlice([
        'homeLoad',
        'homeSearch',
        'listTags',
        'listManualTags',
        'tagLabels',
        'tagFilterOptions',
        'tagManualOptions',
        'overviewStats'
      ]),
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
      }
    },
    videos: {
      ...unsupportedSlice([
        'markScrapeSuccess',
        'setPoster',
        'importSamples',
        'deleteSample',
        'addManualTag',
        'addExistingManualTag',
        'removeManualTag',
        'correctImport',
        'importResource',
        'updateResource',
        'updateLocalResourceLabel',
        'setPrimaryResource',
        'removeResource',
        'previewRemoveFromLibrary',
        'removeFromLibrary',
        'previewMoveResource',
        'moveResource',
        'previewDeleteGlobal',
        'deleteGlobal',
        'merge',
        'splitResource',
        'applyScrapeCandidate'
      ]),
      async edit(input, _ctx: MutationContext) {
        return videos.edit(input.videoId, toVideoEditInput(input.fields))
      },
      async clearMeta(input) {
        return videos.clearMetadata(input.videoId)
      },
      async setRating(input) {
        return videos.setRating(input.videoId, input.rating)
      }
    },
    actresses: unsupportedSlice([
      'list',
      'listPage',
      'pickerPage',
      'pickerGet',
      'get',
      'profile',
      'metadata',
      'videoPage',
      'galleryPage',
      'avatarSourceInfo',
      'mergeCandidates',
      'edit',
      'delete',
      'deleteBatch',
      'deletePreview',
      'clearMeta',
      'importGallery',
      'deleteGallery',
      'setPoster',
      'merge',
      'markScrapeSuccess',
      'applyCrop',
      'applyScrapeCandidate',
      'conflictList',
      'conflictQueuePage',
      'conflictGet',
      'conflictCount',
      'conflictSummary',
      'inspectName',
      'discardConflict',
      'validateIllegal',
      'resolveConflict'
    ]),
    classifications: unsupportedSlice([
      'listOrganizations',
      'pageOrganizations',
      'getOrganization',
      'createOrganization',
      'updateOrganization',
      'mergeOrganizations',
      'deleteOrganization',
      'listDirectors',
      'getDirector',
      'createDirector',
      'updateDirector',
      'mergeDirectors',
      'deleteDirector',
      'listSeries',
      'getSeries',
      'createSeries',
      'updateSeries',
      'mergeSeries',
      'deleteSeries',
      'setImage'
    ]),
    playlists: unsupportedSlice([
      'list',
      'listPage',
      'get',
      'create',
      'update',
      'delete',
      'addVideo',
      'removeVideo',
      'applyImport'
    ]),
    libraries: unsupportedSlice([
      'list',
      'get',
      'create',
      'update',
      'updateConfig',
      'addRoot',
      'updateRoot',
      'removeRoot',
      'cancelRootRemoval',
      'archive',
      'restore',
      'deletePreview',
      'delete',
      'runScan',
      'cancelScan',
      'latestScan',
      'renameFile',
      'importManual',
      'resolvePendingScan',
      'resolveResourceIdentity'
    ]),
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
