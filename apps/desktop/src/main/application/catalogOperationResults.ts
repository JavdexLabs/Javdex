import type { PlaylistApplyImportResult } from '@shared/playlistImportCommit'
import type {
  GlobalSearchResult,
  HomeSnapshot,
  ScopedVideoDetail,
  ScopedVideoListResult
} from '@shared/catalogTypes'
import type {
  PendingVideoScrape,
  PendingVideoScrapePage,
  PendingVideoScrapeResolutionResult,
  VideoDirectorChoiceRequired,
  VideoScrapeField
} from '@shared/videoScrapeTypes'
import type { ActressScrapeField } from '@shared/actressScrapeTypes'
import type { CatalogVideoSourcePage } from '@library/catalog/catalogVideoSources'
import type {
  CorrectImportResult,
  VideoAsset,
  VideoMergeResult,
  VideoResource,
  VideoResourceImportResult,
  VideoResourceKind,
  VideoResourceRemovalResult,
  VideoResourceSplitResult
} from '@shared/videoTypes'
import type {
  TagFilterOptionsPage,
  TagLabel,
  TagListItem,
  TagOptionsPage
} from '@shared/commonTypes'
import type {
  LibraryOverviewStats,
  LibraryScanAudit,
  LibraryScanLatestSnapshot,
  ManualImportResult,
  PendingResourceIdentity,
  PendingResourceIdentityResolutionResult,
  PendingScanGroup,
  PendingScanGroupResolutionResult,
  PendingScanQueuePage,
  RenameImportResult
} from '@shared/libraryTypes'
import type { LibraryPathRemovalPreview } from '@shared/libraryTypes'
import type { AggregateVersion, ExpectedVersions } from '@shared/protocol/versions'
import type { VideoLifecycleImpact, VideoLifecycleResult } from '@shared/videoLifecycleTypes'
import type {
  ActressAvatarSourceInfo,
  ActressDetail,
  ActressGalleryAsset,
  ActressGalleryPage,
  ActressListItem,
  ActressListPage,
  ActressMergeCandidatePage,
  ActressMetadata,
  ActressPickerIdentity,
  ActressPickerPage,
  ActressProfile,
  ActressVideoPage
} from '@shared/actressTypes'
import type { ActressDeleteImpact, ActressDeleteResult } from '@shared/actressIpcContract'
import type {
  ActressConflictQueuePage,
  ActressConflictReviewSummary,
  ActressNameConflictGroup,
  DiscardPendingActressScrapeResult,
  InspectActressConflictNameResult,
  ResolveActressConflictResult,
  ValidateIllegalNameReplacementsResult
} from '@shared/actressConflictTypes'
import type {
  ClassificationImageCandidate,
  ClassificationImageUpdateResult,
  ClassificationListPage,
  DirectorDeleteImpact,
  DirectorDeleteResult,
  DirectorDetail,
  DirectorListItem,
  DirectorMergeResult,
  DirectorOption,
  OrganizationDeleteImpact,
  OrganizationDeleteResult,
  OrganizationDetail,
  OrganizationListItem,
  OrganizationMergeOption,
  OrganizationMergeResult,
  OrganizationOption,
  OrganizationRoleRemovalImpact,
  OrganizationRoleRemovalResult,
  SeriesDeleteImpact,
  SeriesDeleteResult,
  SeriesDetail,
  SeriesListItem,
  SeriesMergeResult,
  SeriesOption
} from '@shared/classificationTypes'
import type {
  PlaylistDetail,
  PlaylistListItem,
  PlaylistListPage,
  PlaylistMetadata,
  PlaylistPage,
  PlaylistVideoMembership,
  PlaylistVideosPage
} from '@shared/playlistTypes'
import type {
  MediaLibraryConfig,
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryRoot,
  MediaLibrarySummary
} from '@shared/mediaLibraryTypes'
import type { BrowseMediaMountResult } from '@shared/mediaLibraryIpcContract'
import type { OperationReceipt } from '@shared/protocol/operationReceipt'
import type { CatalogTaskSnapshot, TargetListPage } from '@shared/protocol/tasks'
import type {
  ScanAuditIndexPage,
  ScanAuditReadHeader,
  ScanAuditViewPage
} from '@shared/scanAuditReadTypes'
import type {
  NfoExportOptions,
  NfoExportPlanFile,
  NfoExportPlanRequest,
  NfoExportPlanSummary,
  NfoExportPreferences,
  NfoExportStateEvent
} from '@shared/nfoExportTypes'
import type {
  AgentMetadataApplyOutcome,
  AgentMetadataDraft,
  AgentMetadataPreviewTransferResult
} from '@shared/agentMetadataTypes'
import type { UploadCreateResult, UploadInspectResult } from '@shared/protocol/uploads'
import type { PlayGrant } from '@shared/protocol/play'
import type { MigrationPreview, MigrationStatus } from '@shared/protocol/migration'
import type { WebDevice } from '@shared/webTypes'

/** Desktop application results, keyed by manage operation. Wire adapters normalize envelopes here. */
export interface CatalogOperationResults {
  'pendingAudit.presence': {
    groupIds: number[]
    identityIds: number[]
    scrapeIds: number[]
  }
  'home.load': HomeSnapshot
  'home.search': GlobalSearchResult
  'videos.list': ScopedVideoListResult
  'videos.get': ScopedVideoDetail | null
  'videos.years': number[]
  'scrape.fields': {
    fields: (VideoScrapeField | ActressScrapeField)[]
  }
  'videos.sources': CatalogVideoSourcePage
  'videos.getResource': {
    locatorRevision: string
    id: number
    library_id: number
    video_id: number
    root_id: number | null
    kind: VideoResourceKind
    locator: string
    resource_key: string
    source_identity: string | null
    strm_source_path: string | null
    size_bytes: number | null
    duration_seconds: number | null
    file_mtime_ms: number | null
    display_name: string | null
    is_primary: number
    add_time: string
  } | null
  'tags.list': TagListItem[]
  'tags.listManual': TagListItem[]
  'tags.labels': TagLabel[]
  'tags.filterOptions': TagFilterOptionsPage
  'tags.manualOptions': TagOptionsPage
  'catalog.overviewStats': LibraryOverviewStats
  'videos.edit': boolean
  'videos.clearMeta': boolean
  'videos.markScrapeSuccess': boolean
  'videos.markScrapeFailed': boolean
  'videos.setRating': boolean
  'videos.setPoster': boolean
  'videos.importSamples': VideoAsset | {
    assetIds: number[]
    versions: {
      V: AggregateVersion
    }
  }
  'videos.deleteSample': boolean
  'videos.addManualTag': boolean
  'videos.addExistingManualTag': boolean
  'videos.removeManualTag': boolean
  'videos.correctImport': CorrectImportResult
  'videos.importResource': VideoResourceImportResult
  'videos.updateResource': VideoResource
  'videos.updateLocalResourceLabel': VideoResource
  'videos.setPrimaryResource': boolean
  'videos.removeResource': VideoResourceRemovalResult
  'videos.previewRemoveFromLibrary': VideoLifecycleImpact
  'videos.removeFromLibrary': VideoLifecycleResult
  'videos.previewMoveResource': VideoLifecycleImpact
  'videos.moveResource': VideoLifecycleResult
  'videos.previewDeleteGlobal': VideoLifecycleImpact
  'videos.deleteGlobal': VideoLifecycleResult
  'videos.merge': VideoMergeResult
  'videos.splitResource': VideoResourceSplitResult
  'videos.applyScrapeCandidate': {
    applied: boolean
    warnings: string[]
    videoId: number
    directorChoice?: VideoDirectorChoiceRequired | undefined
    versions: {
      V: AggregateVersion
    }
  }
  'actresses.list': ActressListItem[]
  'actresses.listPage': ActressListPage
  'actresses.pickerPage': ActressPickerPage
  'actresses.pickerGet': ActressPickerIdentity | null
  'actresses.get': ActressDetail | null
  'actresses.profile': ActressProfile | null
  'actresses.metadata': ActressMetadata | null
  'actresses.videoPage': ActressVideoPage | null
  'actresses.galleryPage': ActressGalleryPage | null
  'actresses.avatarSourceInfo': ActressAvatarSourceInfo | null
  'actresses.mergeCandidates': ActressMergeCandidatePage
  'actresses.edit': boolean
  'actresses.delete': ActressDeleteResult
  'actresses.deleteBatch': ActressDeleteResult
  'actresses.deletePreview': ActressDeleteImpact
  'actresses.clearMeta': boolean
  'actresses.importGallery': ActressGalleryAsset | {
    assetIds: number[]
    versions: {
      A: AggregateVersion
    }
  }
  'actresses.deleteGallery': boolean
  'actresses.setPoster': boolean
  'actresses.merge': boolean
  'actresses.markScrapeSuccess': boolean
  'actresses.markScrapeFailed': boolean
  'actresses.applyCrop': {
    versions: {
      A: AggregateVersion
    }
  }
  'actresses.applyScrapeCandidate': {
    applied: boolean
    warnings: string[]
    actressId: number
    versions: {
      A: AggregateVersion
    }
  }
  'actressConflicts.submit': {
    pendingId: number
    versions: {
      A: AggregateVersion
      Q: {
        generation: number
        revision: number
      }
    }
  }
  'actresses.testTargetPage': ActressPickerPage
  'actressConflicts.list': ActressNameConflictGroup[]
  'actressConflicts.queuePage': ActressConflictQueuePage
  'actressConflicts.get': ActressNameConflictGroup | null
  'actressConflicts.count': number
  'actressConflicts.summary': ActressConflictReviewSummary
  'actressConflicts.inspectName': InspectActressConflictNameResult
  'actressConflicts.discard': DiscardPendingActressScrapeResult
  'actressConflicts.validateIllegal': ValidateIllegalNameReplacementsResult
  'actressConflicts.resolve': ResolveActressConflictResult
  'organizations.list': OrganizationListItem[]
  'organizations.page': ClassificationListPage<OrganizationListItem>
  'organizations.get': OrganizationDetail | null
  'organizations.create': number
  'organizations.update': boolean
  'organizations.merge': OrganizationMergeResult
  'organizations.delete': OrganizationDeleteResult
  'organizations.options': OrganizationOption[]
  'organizations.mergeOptions': OrganizationMergeOption[]
  'organizations.roleRemovePreview': OrganizationRoleRemovalImpact
  'organizations.roleRemove': OrganizationRoleRemovalResult
  'organizations.deletePreview': OrganizationDeleteImpact
  'directors.list': DirectorListItem[]
  'directors.page': ClassificationListPage<DirectorListItem>
  'directors.get': DirectorDetail | null
  'directors.create': number
  'directors.update': boolean
  'directors.merge': DirectorMergeResult
  'directors.delete': DirectorDeleteResult
  'directors.options': DirectorOption[]
  'directors.deletePreview': DirectorDeleteImpact & {
    planId?: string
    planDigest?: string
  }
  'series.list': SeriesListItem[]
  'series.page': ClassificationListPage<SeriesListItem>
  'series.get': SeriesDetail | null
  'series.create': number
  'series.update': boolean
  'series.merge': SeriesMergeResult
  'series.delete': SeriesDeleteResult
  'series.options': SeriesOption[]
  'series.deletePreview': SeriesDeleteImpact
  'classificationImages.page': ClassificationListPage<ClassificationImageCandidate>
  'classificationImages.candidates': ClassificationImageCandidate[]
  'classificationImages.set': ClassificationImageUpdateResult
  'playlists.list': PlaylistListItem[]
  'playlists.listPage': PlaylistListPage
  'playlists.get': PlaylistDetail | null
  'playlists.getPage': PlaylistPage | null
  'playlists.metadata': PlaylistMetadata | null
  'playlists.videoPage': PlaylistVideosPage | null
  'playlists.listForVideo': PlaylistVideoMembership[]
  'playlists.create': number
  'playlists.update': boolean
  'playlists.delete': boolean
  'playlists.addVideo': boolean
  'playlists.removeVideo': boolean
  'playlists.applyImport': PlaylistApplyImportResult
  'libraries.list': MediaLibrarySummary[]
  'libraries.get': MediaLibraryDetail | null
  'libraries.browseMount': BrowseMediaMountResult
  'libraries.create': MediaLibraryDetail
  'libraries.update': MediaLibraryDetail
  'libraries.updateConfig': MediaLibraryConfig
  'libraries.addRoot': MediaLibraryRoot
  'libraries.updateRoot': MediaLibraryRoot
  'libraries.removeRoot': MediaLibraryRoot
  'libraries.removeRootPreview': LibraryPathRemovalPreview
  'libraries.cancelRootRemoval': MediaLibraryRoot
  'libraries.archive': MediaLibraryDetail
  'libraries.restore': MediaLibraryDetail
  'libraries.deletePreview': MediaLibraryDeletePreview
  'libraries.delete': MediaLibraryDetail
  'scans.run': {
    receipt: OperationReceipt
    taskId: string
  }
  'scans.cancel': CatalogTaskSnapshot
  'scans.getLatest': LibraryScanLatestSnapshot
  'scans.auditGet': LibraryScanAudit | null
  'scans.auditHeader': ScanAuditReadHeader
  'scans.auditPage': ScanAuditIndexPage | {
    snapshot: null
    section: 'files' | 'removedResources' | 'promotedResources' | 'deletedVideos' | 'pendingGroups'
    items: never[]
    total: number
    limit: number
    offset: number
  }
  'scans.auditViewPage': ScanAuditViewPage
  'pendingScan.get': PendingScanGroup | null
  'pendingScan.list': PendingScanGroup[]
  'pendingScan.queuePage': PendingScanQueuePage
  'pendingScan.queueCount': number
  'pendingResourceIdentity.get': PendingResourceIdentity | null
  'pendingResourceIdentity.list': PendingResourceIdentity[]
  'files.renamePreview': {
    resourceId?: number | undefined
    planDigest: string
    expectedVersions: ExpectedVersions
  }
  'files.rename': RenameImportResult
  'files.importManual': ManualImportResult
  'pendingScan.resolve': PendingScanGroupResolutionResult
  'pendingResourceIdentity.resolve': PendingResourceIdentityResolutionResult | {
    warnings: string[]
    status: 'assigned'
    videoId: number
  } | {
    warnings: string[]
    status: 'pending'
    pendingGroupId: number
  } | {
    warnings: string[]
    status: 'discarded'
  }
  'nfo.getOptions': NfoExportOptions
  'nfo.updatePreferences': NfoExportPreferences
  'nfo.plan': {
    planDigest: string
    planId: string
    request: NfoExportPlanRequest
    summary: NfoExportPlanSummary
    files: NfoExportPlanFile[]
    warnings: string[]
  }
  'nfo.discardPlan': {
    ok: boolean
  }
  'nfo.start': {
    receipt: OperationReceipt
    taskId: string
  }
  'nfo.terminate': CatalogTaskSnapshot
  'nfo.state': NfoExportStateEvent | {
    taskId: null
    state: 'idle'
  }
  'browser.status': CatalogBrowserStatus
  'browser.setEnabled': CatalogBrowserStatus
  'browser.pairOpen': CatalogBrowserStatus
  'browser.pairInspect': {
    name: string
    expires: number
    remember: boolean
  }
  'browser.pairDecide': CatalogBrowserStatus
  'browser.deviceRemove': CatalogBrowserStatus
  'browser.deviceRename': CatalogBrowserStatus
  'browser.deviceReset': CatalogBrowserStatus
  'browser.revokeSessions': CatalogBrowserStatus
  'tasks.get': CatalogTaskSnapshot
  'tasks.list': CatalogTaskSnapshot[]
  'tasks.cancel': CatalogTaskSnapshot
  'operations.get': OperationReceipt | null
  'targetLists.create': {
    targetListId: string
    count: number
  }
  'targetLists.count': {
    count: number
  }
  'targetLists.page': TargetListPage
  'pendingVideoScrapes.count': number
  'pendingVideoScrapes.existingIds': number[]
  'pendingVideoScrapes.page': PendingVideoScrapePage
  'pendingVideoScrapes.get': PendingVideoScrape | null
  'pendingVideoScrapes.list': PendingVideoScrape[]
  'pendingVideoScrapes.replace': {
    pendingScrapeId: number
    versions: {
      V: AggregateVersion
      Q: {
        generation: number
        revision: number
      }
    }
  }
  'pendingVideoScrapes.confirm': PendingVideoScrapeResolutionResult
  'pendingVideoScrapes.discard': {
    ok: boolean
  }
  'agentMetadata.preview': AgentMetadataPreviewTransferResult
  'agentMetadata.findReady': {
    draft: AgentMetadataDraft | null
    versions: ExpectedVersions
  }
  'agentMetadata.apply': AgentMetadataApplyOutcome & {
    versions?: ExpectedVersions | undefined
  }
  'agentMetadata.discard': {
    ok: boolean
  }
  'uploads.create': UploadCreateResult
  'uploads.inspect': UploadInspectResult
  'play.grant': PlayGrant
  'migration.preview': MigrationPreview
  'migration.start': CatalogTaskSnapshot | MigrationPreview
  'backup.control': import('@shared/protocol/backup').BackupResponse
  'migration.status': MigrationStatus
  'migration.enable': MigrationStatus
  'migration.abandon': MigrationStatus
}
export interface CatalogBrowserStatus {
  enabled: boolean
  running: boolean
  port: number
  username: string
  hasPassword: boolean
  urls: string[]
  devices: WebDevice[]
  pairingUntil: number
  pairingActivity: {
    code: string
    name: string
    state: 'approved' | 'connected'
  }[]
  sessions: number
  error: string | null
}
