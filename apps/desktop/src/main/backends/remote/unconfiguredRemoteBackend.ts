import { structuredError, type StructuredError } from '@shared/protocol/errors'
import type { CatalogBackend } from '../../application/catalogBackend'
import { createRemoteSessionCapabilities } from '../../application/desktopCapabilities'
import {
  EMPTY_DESKTOP_SESSION,
  type DesktopSessionState
} from '@shared/desktop/session'

export interface UnconfiguredRemoteBackendOptions {
  state?: DesktopSessionState
  message?: string
}

const UNCONFIGURED = structuredError(
  'CONNECTION_UNAVAILABLE',
  '远程资料库尚未配置。可修改此电脑设置、重试连接，或切回本地模式。'
)

async function rejectUnconfigured(): Promise<never> {
  throw UNCONFIGURED
}

function rejectSlice<T extends object>(keys: readonly (keyof T)[]): T {
  return Object.fromEntries(keys.map((key) => [key, rejectUnconfigured])) as T
}

/**
 * Remote placeholder when URL is missing or workStore copy is unfinished.
 * Does not open library.db, scan, recover, or Web.
 */
export function createUnconfiguredRemoteBackend(
  options: UnconfiguredRemoteBackendOptions = {}
): CatalogBackend {
  const state = options.state ?? 'disconnected'
  const message = options.message ?? UNCONFIGURED.message
  const session = () => ({
    ...EMPTY_DESKTOP_SESSION,
    state,
    mode: 'remote' as const,
    message
  })
  return {
    mode: 'remote',
    identity: { mode: 'remote', catalogId: '' },
    generation: 0,
    capabilities: () => createRemoteSessionCapabilities(state),
    session,
    async reconnect() {
      return session()
    },
    async claimWriter() {
      throw UNCONFIGURED
    },
    queries: rejectSlice([
      'homeLoad',
      'homeSearch',
      'listVideos',
      'getVideo',
      'listVideoYears',
      'getResource',
      'listTags',
      'listManualTags',
      'tagLabels',
      'tagFilterOptions',
      'tagManualOptions',
      'overviewStats'
    ]),
    videos: rejectSlice([
      'edit',
      'clearMeta',
      'markScrapeSuccess',
      'setRating',
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
    actresses: rejectSlice([
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
      'testTargetPage',
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
    classifications: rejectSlice([
      'listOrganizations',
      'pageOrganizations',
      'getOrganization',
      'createOrganization',
      'updateOrganization',
      'mergeOrganizations',
      'deleteOrganization',
      'organizationOptions',
      'organizationMergeOptions',
      'organizationRoleRemovePreview',
      'organizationRoleRemove',
      'organizationDeletePreview',
      'listDirectors',
      'pageDirectors',
      'getDirector',
      'createDirector',
      'updateDirector',
      'mergeDirectors',
      'deleteDirector',
      'directorOptions',
      'directorDeletePreview',
      'listSeries',
      'pageSeries',
      'getSeries',
      'createSeries',
      'updateSeries',
      'mergeSeries',
      'deleteSeries',
      'seriesOptions',
      'seriesDeletePreview',
      'imagePage',
      'imageCandidates',
      'setImage'
    ]),
    playlists: rejectSlice([
      'list',
      'listPage',
      'get',
      'getPage',
      'metadata',
      'videoPage',
      'listForVideo',
      'create',
      'update',
      'delete',
      'addVideo',
      'removeVideo',
      'applyImport'
    ]),
    libraries: rejectSlice([
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
      'auditGet',
      'auditHeader',
      'auditPage',
      'auditViewPage',
      'getPendingScan',
      'listPendingScans',
      'pagePendingScanQueue',
      'countPendingScanQueue',
      'getPendingResourceIdentity',
      'listPendingResourceIdentities',
      'pendingAuditPresence',
      'renameFile',
      'importManual',
      'resolvePendingScan',
      'resolveResourceIdentity'
    ]),
    nfo: rejectSlice([
      'getOptions',
      'updatePreferences',
      'plan',
      'discardPlan',
      'start',
      'terminate',
      'state'
    ]),
    browser: rejectSlice([
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
    tasks: rejectSlice([
      'get',
      'list',
      'cancel',
      'getOperation',
      'createTargetList',
      'pageTargetList'
    ]),
    pendingVideoScrapes: rejectSlice([
      'count',
      'existingIds',
      'page',
      'get',
      'list',
      'confirm',
      'discard'
    ]),
    agentMetadata: rejectSlice(['findReady', 'apply', 'discard']),
    assets: rejectSlice(['createUpload', 'inspectUpload', 'putUpload', 'grantPlayback', 'readImage']),
    migration: rejectSlice(['preview', 'start', 'status', 'allowEnable', 'enable', 'abandon', 'putPackage']),
    async dispose(): Promise<void> {
      return
    }
  }
}

export function isUnconfiguredRemoteError(error: unknown): error is StructuredError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as StructuredError).code === 'CONNECTION_UNAVAILABLE'
  )
}
