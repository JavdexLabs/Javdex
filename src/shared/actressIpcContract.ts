import { IPC } from './ipc-channels'
import type {
  ActressAvatarAutoCropRequest,
  ActressAvatarAutoCropResponse,
  ActressAvatarSourceInfo,
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressConflictReviewSummary,
  ActressDetail,
  ActressEditInput,
  ActressFaceScanManifestItem,
  ActressGalleryAsset,
  ActressGalleryImportInput,
  ActressGenderFilter,
  ActressListItem,
  ActressListPage,
  ActressListQuery,
  ActressListSortBy,
  ActressMergeInput,
  ActressNameConflictGroup,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  BatchProgress,
  CompositeScraperInput,
  DiscardPendingActressScrapeInput,
  DiscardPendingActressScrapeResult,
  InspectActressConflictNameInput,
  InspectActressConflictNameResult,
  ListSortDir,
  ResolveActressConflictInput,
  ResolveActressConflictResult,
  ScraperPluginDescriptor,
  ScraperPluginPackage,
  ScraperPluginUpdateInput,
  ValidateIllegalNameReplacementsInput,
  ValidateIllegalNameReplacementsResult
} from './types'

export interface ActressDeleteCleanupFailure {
  path: string
  error: string
}

export interface ActressDeleteResult {
  deletedCount: number
  unlinkedVideoCount: number
  cleanupFailures: ActressDeleteCleanupFailure[]
}

export type ActressDeleteMode = 'only-unlinked' | 'unlink-videos-and-delete'

export interface ActressDeleteRequest {
  ids: number[]
  mode: ActressDeleteMode
}

export interface ActressDeleteImpact {
  actressCount: number
  linkedActressCount: number
  affectedVideoCount: number
}

export interface ActressIpcContract {
  [IPC.ACTRESS_LIST]: {
    args: [
      search?: string,
      gender?: ActressGenderFilter,
      sortBy?: ActressListSortBy,
      sortDir?: ListSortDir
    ]
    result: ActressListItem[]
  }
  [IPC.ACTRESS_LIST_PAGE]: {
    args: [query?: ActressListQuery]
    result: ActressListPage
  }
  [IPC.ACTRESS_FACE_SCAN_MANIFEST]: {
    args: []
    result: ActressFaceScanManifestItem[]
  }
  [IPC.ACTRESS_GET]: {
    args: [id: number]
    result: ActressDetail | null
  }
  [IPC.ACTRESS_AVATAR_SOURCE_INFO]: {
    args: [id: number]
    result: ActressAvatarSourceInfo | null
  }
  [IPC.ACTRESS_EDIT]: {
    args: [id: number, input: ActressEditInput]
    result: boolean
  }
  [IPC.ACTRESS_DELETE]: {
    args: [request: ActressDeleteRequest]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_BATCH]: {
    args: [request: ActressDeleteRequest]
    result: ActressDeleteResult
  }
  [IPC.ACTRESS_DELETE_PREVIEW]: {
    args: [ids: number[]]
    result: ActressDeleteImpact
  }
  [IPC.ACTRESS_CLEAR_META]: {
    args: [id: number]
    result: boolean
  }
  [IPC.ACTRESS_GALLERY_IMPORT]: {
    args: [id: number, input: ActressGalleryImportInput]
    result: ActressGalleryAsset
  }
  [IPC.ACTRESS_GALLERY_DELETE]: {
    args: [id: number, assetId: number]
    result: boolean
  }
  [IPC.ACTRESS_POSTER_SET]: {
    args: [id: number, posterPath: string | null]
    result: boolean
  }
  [IPC.ACTRESS_MERGE]: {
    args: [input: ActressMergeInput]
    result: boolean
  }
  [IPC.ACTRESS_MARK_SCRAPE_SUCCESS]: {
    args: [id: number]
    result: boolean
  }
  [IPC.ACTRESS_CONFLICT_LIST]: {
    args: []
    result: ActressNameConflictGroup[]
  }
  [IPC.ACTRESS_CONFLICT_COUNT]: {
    args: []
    result: number
  }
  [IPC.ACTRESS_CONFLICT_SUMMARY]: {
    args: []
    result: ActressConflictReviewSummary
  }
  [IPC.ACTRESS_CONFLICT_INSPECT_NAME]: {
    args: [input: InspectActressConflictNameInput]
    result: InspectActressConflictNameResult
  }
  [IPC.ACTRESS_CONFLICT_DISCARD]: {
    args: [input: DiscardPendingActressScrapeInput]
    result: DiscardPendingActressScrapeResult
  }
  [IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL]: {
    args: [input: ValidateIllegalNameReplacementsInput]
    result: ValidateIllegalNameReplacementsResult
  }
  [IPC.ACTRESS_CONFLICT_RESOLVE]: {
    args: [input: ResolveActressConflictInput]
    result: ResolveActressConflictResult
  }
  [IPC.ACTRESS_SCRAPER_LIST]: { args: []; result: string[] }
  [IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS]: { args: []; result: ScraperPluginDescriptor[] }
  [IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT]: { args: [name: string]; result: string | null }
  [IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE]: { args: [name: string]; result: ScraperPluginPackage }
  [IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE]: {
    args: [name: string, input: ScraperPluginUpdateInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_PLUGIN_DELETE]: { args: [name: string]; result: boolean }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE]: {
    args: [input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE]: {
    args: [name: string, input: CompositeScraperInput]
    result: ScraperPluginDescriptor
  }
  [IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE]: { args: [name: string]; result: boolean }
  [IPC.ACTRESS_SCRAPE_ONE]: {
    args: [
      actressId: number,
      scraperName?: string,
      fields?: ActressScrapeField[],
      mode?: ActressScrapeUpdateMode,
      queryName?: string,
      useAliases?: boolean,
      autoCropAvatar?: boolean
    ]
    result: ActressScrapeDisposition
  }
  [IPC.ACTRESS_SCRAPE_BATCH_COUNT]: { args: [filter: ActressBatchScrapeFilter]; result: number }
  [IPC.ACTRESS_SCRAPE_BATCH_START]: {
    args: [request?: ActressBatchScrapeRequest | string]
    result: boolean
  }
  [IPC.ACTRESS_SCRAPE_BATCH_CANCEL]: { args: []; result: boolean }
  [IPC.ACTRESS_AVATAR_AUTO_CROP_RESULT]: {
    args: [response: ActressAvatarAutoCropResponse]
    result: boolean
  }
}

export interface ActressIpcEventContract {
  [IPC.ACTRESS_SCRAPE_BATCH_PROGRESS]: BatchProgress
  [IPC.ACTRESS_AVATAR_AUTO_CROP_REQUEST]: ActressAvatarAutoCropRequest
}

export type ActressIpcChannel = keyof ActressIpcContract
export type ActressIpcArgs<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['args']
export type ActressIpcResult<Channel extends ActressIpcChannel> = ActressIpcContract[Channel]['result']
export type ActressIpcEventChannel = keyof ActressIpcEventContract
export type ActressIpcEvent<Channel extends ActressIpcEventChannel> =
  ActressIpcEventContract[Channel]
