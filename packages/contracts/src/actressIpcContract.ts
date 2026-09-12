import type { ActressProfile } from './actressTypes'
import type { ActressGalleryPage, ActressGalleryPageQuery } from './actressTypes'
import type { ActressMetadata } from './actressTypes'
import type { ActressVideoPage, ActressVideoPageQuery } from './actressTypes'
import type { ActressAvatarAutoCropTarget } from './actressAvatarCropTypes'
import type { ActressMergeCandidatePage, ActressMergeCandidateQuery } from './actressTypes'
import type { ActressPickerIdentity, ActressPickerPage, ActressPickerQuery } from './actressTypes'
import { IPC } from './ipc-channels'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult
} from './typedIpcContract'
import type { SortDir } from './commonTypes'
import type { ActressAvatarSourceInfo, ActressDetail, ActressEditInput, ActressFaceScanManifestItem, ActressGalleryAsset, ActressGalleryImportInput, ActressGenderFilter, ActressListItem, ActressListPage, ActressListQuery, ActressListSortBy, ActressMergeInput } from './actressTypes'
import type { ActressConflictQueuePage, ActressConflictQueueQuery, ActressConflictReviewSummary, ActressNameConflictGroup, DiscardPendingActressScrapeInput, DiscardPendingActressScrapeResult, InspectActressConflictNameInput, InspectActressConflictNameResult, ResolveActressConflictInput, ResolveActressConflictResult, ValidateIllegalNameReplacementsInput, ValidateIllegalNameReplacementsResult } from './actressConflictTypes'

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
      sortDir?: SortDir
    ]
    result: ActressListItem[]
  }
  [IPC.ACTRESS_MERGE_CANDIDATES]: {
    args: [query: ActressMergeCandidateQuery]
    result: ActressMergeCandidatePage
  }
  [IPC.ACTRESS_AVATAR_CROP_TARGETS]: {
    args: []
    result: ActressAvatarAutoCropTarget[]
  }
  [IPC.ACTRESS_AVATAR_CROP_COUNT]: {
    args: []
    result: number
  }
  [IPC.ACTRESS_TEST_TARGET_PAGE]: { args: [query?: ActressPickerQuery]; result: ActressPickerPage }
  [IPC.ACTRESS_TEST_TARGET_GET]: { args: [id: number]; result: string | null }
  [IPC.ACTRESS_PICKER_GET]: {
    args: [id: number]
    result: ActressPickerIdentity | null
  }
  [IPC.ACTRESS_PICKER_PAGE]: {
    args: [query?: ActressPickerQuery]
    result: ActressPickerPage
  }
  [IPC.ACTRESS_LIST_PAGE]: {
    args: [query?: ActressListQuery]
    result: ActressListPage
  }
  [IPC.ACTRESS_FACE_SCAN_MANIFEST]: {
    args: []
    result: ActressFaceScanManifestItem[]
  }
  [IPC.ACTRESS_GALLERY_PAGE]: {
    args: [id: number, query?: ActressGalleryPageQuery]
    result: ActressGalleryPage | null
  }
  [IPC.ACTRESS_PROFILE]: { args: [id: number]; result: ActressProfile | null }
  [IPC.ACTRESS_METADATA]: {
    args: [id: number]
    result: ActressMetadata | null
  }
  [IPC.ACTRESS_VIDEO_PAGE]: {
    args: [id: number, query?: ActressVideoPageQuery]
    result: ActressVideoPage | null
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
  [IPC.ACTRESS_CONFLICT_QUEUE_PAGE]: {
    args: [query: ActressConflictQueueQuery]
    result: ActressConflictQueuePage
  }
  [IPC.ACTRESS_CONFLICT_GET]: {
    args: [normalizedName: string]
    result: ActressNameConflictGroup | null
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
}

export type ActressIpcChannel = IpcContractChannel<ActressIpcContract>
export type ActressIpcArgs<Channel extends ActressIpcChannel> =
  IpcContractArgs<ActressIpcContract, Channel>
export type ActressIpcResult<Channel extends ActressIpcChannel> =
  IpcContractResult<ActressIpcContract, Channel>
