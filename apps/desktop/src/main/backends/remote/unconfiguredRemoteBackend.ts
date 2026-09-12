import { structuredError, type StructuredError } from '@shared/protocol/errors'
import type { CatalogBackend } from '../../application/catalogBackend'
import { createUnconfiguredRemoteCapabilities } from '../../application/desktopCapabilities'
import { EMPTY_DESKTOP_SESSION } from '@shared/desktop/session'

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
 * Remote factory placeholder for S02D. Does not open library.db, scan, recover, or Web.
 * A real RemoteCatalogBackend is S07 after S05/S06 exist.
 */
export function createUnconfiguredRemoteBackend(): CatalogBackend {
  return {
    mode: 'remote',
    identity: { mode: 'remote', catalogId: '' },
    generation: 0,
    capabilities: createUnconfiguredRemoteCapabilities,
    session: () => ({
      ...EMPTY_DESKTOP_SESSION,
      state: 'disconnected',
      mode: 'remote',
      message: UNCONFIGURED.message
    }),
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
    playlists: rejectSlice([
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
    assets: rejectSlice(['createUpload', 'inspectUpload', 'grantPlayback']),
    migration: rejectSlice(['preview', 'start', 'status', 'allowEnable', 'enable', 'abandon']),
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
