import { IPC } from './ipc-channels'
import type { LlmModelDefinition } from './llmProviders'
import type {
  AssetCryptoProgress,
  FacetItem,
  FacetType,
  LibraryOverviewStats,
  LibraryPathRemovalPreview,
  ManualImportResult,
  PlayResult,
  RenameImportResult,
  ScanProgress,
  ScanResult
} from './libraryTypes'
import type { TagListItem, SortDir } from './commonTypes'
import type {
  PlaylistCreateInput,
  PlaylistDetail,
  PlaylistListItem,
  PlaylistUpdateInput,
  PlaylistVideoMembership,
  PlaylistVideoSortBy
} from './playlistTypes'
import type {
  PluginDevAgentEvent,
  PluginDevAgentMessageInput,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevInstallInput,
  PluginDevVerificationReport,
  PluginDevVerifyInput
} from './pluginDevTypes'
import type { ScraperPluginDescriptor } from './scraperPluginTypes'
import type { AppSettings } from './settingsTypes'
import type {
  IpcContractArgs,
  IpcContractChannel,
  IpcContractResult,
  IpcEventChannel,
  IpcEventPayload
} from './typedIpcContract'
import type { ProjectPage, UpdateCheckState } from './updateTypes'
import type {
  ClassificationEntityRef,
  ClassificationImageCandidate,
  ClassificationImageInput,
  ClassificationImageUpdateResult,
  DirectorDetail,
  DirectorDeleteImpact,
  DirectorDeleteResult,
  DirectorListItem,
  DirectorListQuery,
  DirectorMergeInput,
  DirectorMergeResult,
  DirectorOption,
  DirectorProfileInput,
  DirectorUpdateInput,
  OrganizationCreateInput,
  OrganizationDeleteImpact,
  OrganizationDeleteResult,
  OrganizationDetail,
  OrganizationListItem,
  OrganizationListQuery,
  OrganizationMergeInput,
  OrganizationMergeOption,
  OrganizationMergeResult,
  OrganizationOption,
  OrganizationRole,
  OrganizationRoleRemovalImpact,
  OrganizationRoleRemovalResult,
  OrganizationUpdateInput,
  SeriesDetail,
  SeriesDeleteImpact,
  SeriesDeleteResult,
  SeriesListItem,
  SeriesListQuery,
  SeriesMergeInput,
  SeriesMergeResult,
  SeriesOption,
  SeriesProfileInput,
  SeriesUpdateInput
} from './classificationTypes'

export interface RemoteImagePreviewResult {
  mimeType: string
  dataBase64: string
}

export interface AppIpcContract {
  [IPC.SETTINGS_GET]: { args: []; result: AppSettings }
  [IPC.SETTINGS_UPDATE]: { args: [patch: Partial<AppSettings>]; result: AppSettings }
  [IPC.SETTINGS_PICK_FOLDER]: { args: []; result: string[] }
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW]: {
    args: [path: string]
    result: LibraryPathRemovalPreview
  }
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM]: { args: [path: string]; result: AppSettings }
  [IPC.SETTINGS_LLM_TEST_MODEL]: { args: [providerId: string, modelId: string]; result: string }
  [IPC.SETTINGS_LLM_LIST_MODELS]: { args: [providerId: string]; result: LlmModelDefinition[] }
  [IPC.SETTINGS_PROXY_TEST]: { args: [kind: 'scrape' | 'llm', proxyUrl: string]; result: string }
  [IPC.SETTINGS_OVERVIEW_STATS]: { args: []; result: LibraryOverviewStats }

  [IPC.APP_UPDATE_GET_STATE]: { args: []; result: UpdateCheckState }
  [IPC.APP_UPDATE_CHECK]: { args: []; result: UpdateCheckState }
  [IPC.APP_UPDATE_OPEN_RELEASE]: { args: []; result: boolean }
  [IPC.APP_UPDATE_OPEN_PROJECT_PAGE]: { args: [page: ProjectPage]; result: boolean }
  [IPC.EXTERNAL_LINK_OPEN]: { args: [url: string]; result: boolean }
  [IPC.APP_UPDATE_IGNORE_VERSION]: { args: [version: string]; result: UpdateCheckState }

  [IPC.SCAN_RUN]: { args: [folders?: string[]]; result: ScanResult }
  [IPC.SCAN_CANCEL]: { args: []; result: boolean }
  [IPC.FILE_RENAME]: { args: [oldPath: string, newName: string]; result: RenameImportResult }
  [IPC.FILE_IMPORT_MANUAL]: { args: [filePath: string, code: string]; result: ManualImportResult }

  [IPC.PLAYLIST_LIST]: { args: []; result: PlaylistListItem[] }
  [IPC.PLAYLIST_GET]: {
    args: [id: number, sortBy?: PlaylistVideoSortBy, sortDir?: SortDir]
    result: PlaylistDetail | null
  }
  [IPC.PLAYLIST_CREATE]: { args: [input: PlaylistCreateInput]; result: number }
  [IPC.PLAYLIST_UPDATE]: { args: [id: number, input: PlaylistUpdateInput]; result: boolean }
  [IPC.PLAYLIST_DELETE]: { args: [id: number]; result: boolean }
  [IPC.PLAYLIST_LIST_FOR_VIDEO]: { args: [videoId: number]; result: PlaylistVideoMembership[] }
  [IPC.PLAYLIST_ADD_VIDEO]: { args: [playlistId: number, videoId: number]; result: boolean }
  [IPC.PLAYLIST_REMOVE_VIDEO]: { args: [playlistId: number, videoId: number]; result: boolean }

  [IPC.TAG_LIST]: { args: []; result: TagListItem[] }
  [IPC.TAG_LIST_MANUAL]: { args: []; result: TagListItem[] }
  [IPC.FACET_LIST]: { args: [type: FacetType]; result: FacetItem[] }
  [IPC.FACET_DELETE]: { args: [type: FacetType, value: string]; result: boolean }
  [IPC.ORGANIZATION_LIST]: {
    args: [query: OrganizationListQuery]
    result: OrganizationListItem[]
  }
  [IPC.ORGANIZATION_GET]: {
    args: [id: number, role: OrganizationRole]
    result: OrganizationDetail | null
  }
  [IPC.ORGANIZATION_OPTIONS]: {
    args: [search?: string]
    result: OrganizationOption[]
  }
  [IPC.ORGANIZATION_MERGE_OPTIONS]: {
    args: [search?: string]
    result: OrganizationMergeOption[]
  }
  [IPC.ORGANIZATION_CREATE]: { args: [input: OrganizationCreateInput]; result: number }
  [IPC.ORGANIZATION_UPDATE]: {
    args: [id: number, input: OrganizationUpdateInput]
    result: boolean
  }
  [IPC.ORGANIZATION_MERGE]: {
    args: [input: OrganizationMergeInput]
    result: OrganizationMergeResult
  }
  [IPC.ORGANIZATION_ROLE_REMOVE_PREVIEW]: {
    args: [id: number, role: OrganizationRole]
    result: OrganizationRoleRemovalImpact
  }
  [IPC.ORGANIZATION_ROLE_REMOVE]: {
    args: [id: number, role: OrganizationRole]
    result: OrganizationRoleRemovalResult
  }
  [IPC.ORGANIZATION_DELETE_PREVIEW]: {
    args: [id: number]
    result: OrganizationDeleteImpact
  }
  [IPC.ORGANIZATION_DELETE]: {
    args: [id: number]
    result: OrganizationDeleteResult
  }
  [IPC.DIRECTOR_LIST]: { args: [query: DirectorListQuery]; result: DirectorListItem[] }
  [IPC.DIRECTOR_GET]: { args: [id: number]; result: DirectorDetail | null }
  [IPC.DIRECTOR_OPTIONS]: { args: [search?: string]; result: DirectorOption[] }
  [IPC.DIRECTOR_CREATE]: { args: [input: DirectorProfileInput]; result: number }
  [IPC.DIRECTOR_UPDATE]: { args: [id: number, input: DirectorUpdateInput]; result: boolean }
  [IPC.DIRECTOR_MERGE]: { args: [input: DirectorMergeInput]; result: DirectorMergeResult }
  [IPC.DIRECTOR_DELETE_PREVIEW]: { args: [id: number]; result: DirectorDeleteImpact }
  [IPC.DIRECTOR_DELETE]: { args: [id: number]; result: DirectorDeleteResult }
  [IPC.SERIES_LIST]: { args: [query: SeriesListQuery]; result: SeriesListItem[] }
  [IPC.SERIES_GET]: { args: [id: number]; result: SeriesDetail | null }
  [IPC.SERIES_OPTIONS]: { args: [search?: string]; result: SeriesOption[] }
  [IPC.SERIES_CREATE]: { args: [input: SeriesProfileInput]; result: number }
  [IPC.SERIES_UPDATE]: { args: [id: number, input: SeriesUpdateInput]; result: boolean }
  [IPC.SERIES_MERGE]: { args: [input: SeriesMergeInput]; result: SeriesMergeResult }
  [IPC.SERIES_DELETE_PREVIEW]: { args: [id: number]; result: SeriesDeleteImpact }
  [IPC.SERIES_DELETE]: { args: [id: number]; result: SeriesDeleteResult }
  [IPC.CLASSIFICATION_IMAGE_CANDIDATES]: {
    args: [entity: ClassificationEntityRef]
    result: ClassificationImageCandidate[]
  }
  [IPC.CLASSIFICATION_IMAGE_SET]: {
    args: [entity: ClassificationEntityRef, input: ClassificationImageInput | null]
    result: ClassificationImageUpdateResult
  }

  [IPC.PLUGIN_DEV_AGENT_START]: {
    args: [input: PluginDevAgentStartInput]
    result: PluginDevAgentSessionResult
  }
  [IPC.PLUGIN_DEV_AGENT_MESSAGE]: {
    args: [input: PluginDevAgentMessageInput]
    result: PluginDevAgentSessionResult
  }
  [IPC.PLUGIN_DEV_AGENT_CANCEL]: { args: [sessionId: string]; result: void }
  [IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG]: { args: [sessionId: string]; result: string | null }
  [IPC.PLUGIN_DEV_DRY_RUN]: { args: [input: PluginDevDryRunInput]; result: PluginDevDryRunResult }
  [IPC.PLUGIN_DEV_VERIFY]: {
    args: [input: PluginDevVerifyInput]
    result: PluginDevVerificationReport
  }
  [IPC.PLUGIN_DEV_INSTALL]: {
    args: [input: PluginDevInstallInput]
    result: ScraperPluginDescriptor
  }

  [IPC.PLAYER_PLAY]: { args: [videoId: number]; result: PlayResult }
  [IPC.PLAYER_REVEAL]: { args: [videoId: number]; result: PlayResult }
  [IPC.PLAYER_OPEN_RESOURCE]: { args: [resourceId: number]; result: PlayResult }
  [IPC.PLAYER_REVEAL_RESOURCE]: { args: [resourceId: number]; result: PlayResult }

  [IPC.ASSET_CRYPTO_SET]: { args: [enabled: boolean]; result: AppSettings }
  [IPC.ASSET_STORAGE_RELOCATE]: { args: [targetPath?: string | null]; result: AppSettings }
  [IPC.ASSET_FETCH_REMOTE_IMAGE]: { args: [url: string]; result: RemoteImagePreviewResult }
  [IPC.LLM_TRANSLATE_TO_CHINESE]: { args: [text: string]; result: string }
}

export interface AppIpcEventContract {
  [IPC.APP_UPDATE_STATE_CHANGED]: UpdateCheckState
  [IPC.SCAN_PROGRESS]: ScanProgress
  [IPC.PLUGIN_DEV_AGENT_EVENT]: PluginDevAgentEvent
  [IPC.ASSET_CRYPTO_PROGRESS]: AssetCryptoProgress
}

export type AppIpcChannel = IpcContractChannel<AppIpcContract>
export type AppIpcArgs<Channel extends AppIpcChannel> = IpcContractArgs<AppIpcContract, Channel>
export type AppIpcResult<Channel extends AppIpcChannel> = IpcContractResult<AppIpcContract, Channel>
export type AppIpcEventChannel = IpcEventChannel<AppIpcEventContract>
export type AppIpcEvent<Channel extends AppIpcEventChannel> = IpcEventPayload<AppIpcEventContract, Channel>
