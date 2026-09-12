import { IPC } from './ipc-channels'
import type {
  GlobalSearchInput,
  GlobalSearchResult,
  HomeDiscoveryInput,
  HomeSnapshot
} from './catalogTypes'
import type {
  CreateMediaLibraryInput,
  CreateMediaLibraryRootInput,
  MediaLibraryConfig,
  MediaLibraryConfigPatch,
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryPatch,
  MediaLibraryRoot,
  MediaLibraryRootMigrationPreview,
  MediaLibraryRootMigrationResult,
  MediaLibraryRootPatch,
  MediaLibrarySummary,
  MigrateMediaLibraryRootInput
} from './mediaLibraryTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult
} from './typedIpcContract'

export interface MediaLibraryListInput {
  includeArchived?: boolean
}

export interface UpdateMediaLibraryInput {
  libraryId: number
  expectedRevision: number
  patch: MediaLibraryPatch
}

export interface UpdateMediaLibraryConfigInput {
  libraryId: number
  expectedRevision: number
  patch: MediaLibraryConfigPatch
}

export interface AddMediaLibraryRootInput {
  libraryId: number
  expectedRevision: number
  root: CreateMediaLibraryRootInput
}

export interface UpdateMediaLibraryRootInput {
  libraryId: number
  rootId: number
  expectedRevision: number
  patch: MediaLibraryRootPatch
}

export interface RemoveMediaLibraryRootInput {
  libraryId: number
  rootId: number
  expectedRevision: number
  /** Frozen root-owned data graph returned by the mandatory removal preview. */
  expectedImpactRevision: string
}

export interface CancelMediaLibraryRootRemovalInput {
  libraryId: number
  rootId: number
  expectedRevision: number
}

export interface MediaLibraryRevisionInput {
  libraryId: number
  expectedRevision: number
}

export interface DeleteMediaLibraryInput extends MediaLibraryRevisionInput {
  expectedImpactRevision: string
}

export interface MediaLibraryDeletePreviewInput {
  libraryId: number
}

export interface MediaLibraryRootMigrationPreviewInput {
  sourceLibraryId: number
  targetLibraryId: number
  rootId: number
}

/** Typed seam for media-library management and cross-library discovery. */
export interface MediaLibraryIpcContract {
  [IPC.MEDIA_LIBRARY_LIST]: {
    args: [input?: MediaLibraryListInput]
    result: MediaLibrarySummary[]
  }
  [IPC.MEDIA_LIBRARY_GET]: {
    args: [libraryId: number]
    result: MediaLibraryDetail | null
  }
  [IPC.MEDIA_LIBRARY_CREATE]: {
    args: [input: CreateMediaLibraryInput]
    result: MediaLibraryDetail
  }
  [IPC.MEDIA_LIBRARY_UPDATE]: {
    args: [input: UpdateMediaLibraryInput]
    result: MediaLibraryDetail
  }
  [IPC.MEDIA_LIBRARY_CONFIG_UPDATE]: {
    args: [input: UpdateMediaLibraryConfigInput]
    result: MediaLibraryConfig
  }
  [IPC.MEDIA_LIBRARY_ROOT_ADD]: {
    args: [input: AddMediaLibraryRootInput]
    result: MediaLibraryRoot
  }
  [IPC.MEDIA_LIBRARY_ROOT_UPDATE]: {
    args: [input: UpdateMediaLibraryRootInput]
    result: MediaLibraryRoot
  }
  [IPC.MEDIA_LIBRARY_ROOT_REMOVE]: {
    args: [input: RemoveMediaLibraryRootInput]
    result: MediaLibraryRoot
  }
  [IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL]: {
    args: [input: CancelMediaLibraryRootRemovalInput]
    result: MediaLibraryRoot
  }
  [IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW]: {
    args: [input: MediaLibraryRootMigrationPreviewInput]
    result: MediaLibraryRootMigrationPreview
  }
  [IPC.MEDIA_LIBRARY_ROOT_MIGRATE]: {
    args: [input: MigrateMediaLibraryRootInput]
    result: MediaLibraryRootMigrationResult
  }
  [IPC.MEDIA_LIBRARY_ARCHIVE]: {
    args: [input: MediaLibraryRevisionInput]
    result: MediaLibraryDetail
  }
  [IPC.MEDIA_LIBRARY_RESTORE]: {
    args: [input: MediaLibraryRevisionInput]
    result: MediaLibraryDetail
  }
  [IPC.MEDIA_LIBRARY_DELETE_PREVIEW]: {
    args: [input: MediaLibraryDeletePreviewInput]
    result: MediaLibraryDeletePreview
  }
  [IPC.MEDIA_LIBRARY_DELETE]: {
    args: [input: DeleteMediaLibraryInput]
    result: MediaLibraryDetail
  }
  [IPC.HOME_LOAD]: {
    args: [input: HomeDiscoveryInput]
    result: HomeSnapshot
  }
  [IPC.HOME_SEARCH]: {
    args: [input: GlobalSearchInput]
    result: GlobalSearchResult
  }
}

export type MediaLibraryIpcChannel = IpcContractChannel<MediaLibraryIpcContract>
export type MediaLibraryIpcArgs<Channel extends MediaLibraryIpcChannel> =
  IpcContractArgs<MediaLibraryIpcContract, Channel>
export type MediaLibraryIpcResult<Channel extends MediaLibraryIpcChannel> =
  IpcContractResult<MediaLibraryIpcContract, Channel>
