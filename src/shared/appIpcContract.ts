import type { WebAccessInput, WebAccessStatus } from './webTypes'
import { IPC } from './ipc-channels'
import type {
  ModelCandidate,
  ModelManagementApplyInput,
  ModelManagementApplyResult,
  ModelManagementSnapshot,
  ModelTestResult
} from './modelManagementTypes'
import type {
  AssetCryptoProgress,
  LibraryOverviewStats,
  LibraryPathRemovalPreview,
  LibraryScanAudit,
  LibraryScanEvent,
  LibraryScanLatestSnapshot,
  LibraryScanProgressEvent,
  ManualImportResult,
  PendingLibraryPathCleanup,
  PendingResourceIdentity,
  PendingResourceIdentityResolution,
  PendingResourceIdentityResolutionResult,
  PendingScanGroup,
  PendingScanGroupResolution,
  PendingScanGroupResolutionResult,
  PlayResult,
  RenameImportResult,
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
  PluginDevAgentSnapshot,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevInstallInput
} from './pluginDevTypes'
import type { ScraperPluginDescriptor } from './scraperPluginTypes'
import type { RendererSettingsPatch, SettingsSnapshot } from './settingsTypes'
import type { VideoResourceImportTarget } from './videoTypes'
import type {
  LibraryCuratorMessageInput,
  LibraryCuratorResult,
  LibraryCuratorSnapshot,
  LibraryCuratorStartInput
} from './libraryCuratorTypes'
import type {
  PlaylistImportControlCommand,
  PlaylistImportSnapshot,
  PlaylistImportSnapshotChangedEvent,
  PlaylistImportStartInput
} from './playlistImportTypes'
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
import type {
  AgentMetadataApplyInput,
  AgentMetadataApplyOutcome,
  AgentMetadataDiscardInput,
  AgentMetadataDraft,
  AgentMetadataPlanInput,
  AgentMetadataResumeInput,
  AgentMetadataReview,
  AgentMetadataSnapshot,
  AgentMetadataSnapshotChangedEvent,
  AgentMetadataStartInput,
  AgentMetadataTarget
} from './agentMetadataTypes'

export interface RemoteImagePreviewResult {
  mimeType: string
  dataBase64: string
}

export interface AppIpcContract {
  [IPC.WEB_ACCESS_PAIR_OPEN]: { args: []; result: WebAccessStatus }
  [IPC.WEB_ACCESS_PAIR_INSPECT]: { args: [string]; result: { name: string; expires: number; remember: boolean } }
  [IPC.WEB_ACCESS_PAIR_DECIDE]: { args: [string, boolean]; result: WebAccessStatus }
  [IPC.WEB_ACCESS_DEVICE_REMOVE]: { args: [string]; result: WebAccessStatus }
  [IPC.WEB_ACCESS_DEVICE_RENAME]: { args: [string, string]; result: WebAccessStatus }
  [IPC.WEB_ACCESS_DEVICE_RESET]: { args: []; result: WebAccessStatus }
  [IPC.WEB_ACCESS_STATUS]: { args: []; result: WebAccessStatus }
  [IPC.WEB_ACCESS_APPLY]: { args: [WebAccessInput]; result: WebAccessStatus }
  [IPC.WEB_ACCESS_REVOKE]: { args: []; result: WebAccessStatus }
  [IPC.SETTINGS_GET]: { args: []; result: SettingsSnapshot }
  [IPC.SETTINGS_UPDATE]: { args: [patch: RendererSettingsPatch]; result: SettingsSnapshot }
  [IPC.SETTINGS_PICK_FOLDER]: { args: []; result: string[] }
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW]: {
    args: [libraryId: number, rootId: number]
    result: LibraryPathRemovalPreview
  }
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM]: {
    args: [
      libraryId: number,
      rootId: number,
      expectedRevision: number,
      expectedImpactRevision: string
    ]
    result: PendingLibraryPathCleanup
  }
  [IPC.SETTINGS_MODEL_MANAGEMENT_GET]: { args: []; result: ModelManagementSnapshot }
  [IPC.SETTINGS_MODEL_MANAGEMENT_APPLY]: {
    args: [input: ModelManagementApplyInput]
    result: ModelManagementApplyResult
  }
  [IPC.SETTINGS_MODEL_MANAGEMENT_DISCOVER_MODELS]: {
    args: [connectionId: string]
    result: ModelCandidate[]
  }
  [IPC.SETTINGS_MODEL_MANAGEMENT_TEST_MODEL]: {
    args: [modelRef: string]
    result: ModelTestResult
  }
  [IPC.SETTINGS_RECOVERY_REVEAL_BACKUP]: { args: []; result: boolean }
  [IPC.SETTINGS_PROXY_TEST]: { args: [kind: 'scrape' | 'llm', proxyUrl: string]; result: string }
  [IPC.SETTINGS_OVERVIEW_STATS]: { args: []; result: LibraryOverviewStats }

  [IPC.APP_UPDATE_GET_STATE]: { args: []; result: UpdateCheckState }
  [IPC.APP_UPDATE_CHECK]: { args: []; result: UpdateCheckState }
  [IPC.APP_UPDATE_OPEN_RELEASE]: { args: []; result: boolean }
  [IPC.APP_UPDATE_OPEN_PROJECT_PAGE]: { args: [page: ProjectPage]; result: boolean }
  [IPC.EXTERNAL_LINK_OPEN]: { args: [url: string]; result: boolean }
  [IPC.APP_UPDATE_IGNORE_VERSION]: { args: [version: string]; result: UpdateCheckState }

  [IPC.SCAN_RUN]: {
    args: [libraryId: number, rootIds?: number[]]
    result: ScanResult
  }
  [IPC.SCAN_CANCEL]: { args: [runId: string]; result: boolean }
  [IPC.SCAN_LATEST_GET]: {
    args: [libraryId: number]
    result: LibraryScanLatestSnapshot
  }
  [IPC.SCAN_AUDIT_GET]: {
    args: [libraryId: number]
    result: LibraryScanAudit | null
  }
  [IPC.SCAN_AUDIT_REVEAL_FILE]: {
    args: [libraryId: number, filePath: string]
    result: PlayResult
  }
  [IPC.FILE_RENAME]: {
    args: [
      libraryId: number,
      rootId: number,
      oldPath: string,
      newName: string
    ]
    result: RenameImportResult
  }
  [IPC.FILE_IMPORT_MANUAL]: {
    args: [
      libraryId: number,
      rootId: number,
      filePath: string,
      code: string,
      target: VideoResourceImportTarget
    ]
    result: ManualImportResult
  }
  [IPC.PENDING_SCAN_LIST]: {
    args: [libraryId: number]
    result: PendingScanGroup[]
  }
  [IPC.PENDING_SCAN_RESOLVE]: {
    args: [libraryId: number, groupId: number, resolution: PendingScanGroupResolution]
    result: PendingScanGroupResolutionResult
  }
  [IPC.PENDING_RESOURCE_IDENTITY_LIST]: {
    args: [libraryId: number]
    result: PendingResourceIdentity[]
  }
  [IPC.PENDING_RESOURCE_IDENTITY_RESOLVE]: {
    args: [libraryId: number, identityId: number, resolution: PendingResourceIdentityResolution]
    result: PendingResourceIdentityResolutionResult
  }

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
  [IPC.PLUGIN_DEV_AGENT_RELEASE_BROWSER]: { args: [sessionId: string]; result: void }
  [IPC.PLUGIN_DEV_AGENT_SNAPSHOT]: {
    args: [sessionId?: string]
    result: PluginDevAgentSnapshot | null
  }
  [IPC.PLUGIN_DEV_AGENT_CLEAR_HISTORY]: { args: []; result: number }
  [IPC.PLUGIN_DEV_AGENT_DISCARD_UNRECOVERABLE]: { args: []; result: number }
  [IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG]: { args: [sessionId: string]; result: string | null }
  [IPC.PLUGIN_DEV_DRY_RUN]: { args: [input: PluginDevDryRunInput]; result: PluginDevDryRunResult }
  [IPC.PLUGIN_DEV_INSTALL]: {
    args: [input: PluginDevInstallInput]
    result: ScraperPluginDescriptor
  }
  [IPC.LIBRARY_CURATOR_START]: {
    args: [input?: LibraryCuratorStartInput]
    result: LibraryCuratorResult
  }
  [IPC.LIBRARY_CURATOR_MESSAGE]: {
    args: [input: LibraryCuratorMessageInput]
    result: LibraryCuratorResult
  }
  [IPC.LIBRARY_CURATOR_CANCEL]: { args: [runId: string]; result: void }
  [IPC.LIBRARY_CURATOR_SNAPSHOT]: {
    args: [runId?: string]
    result: LibraryCuratorSnapshot | null
  }
  [IPC.AGENT_METADATA_START]: {
    args: [input: AgentMetadataStartInput]
    result: AgentMetadataSnapshot
  }
  [IPC.AGENT_METADATA_RESUME]: {
    args: [input: AgentMetadataResumeInput]
    result: AgentMetadataSnapshot
  }
  [IPC.AGENT_METADATA_CANCEL]: { args: [runId: string]; result: void }
  [IPC.AGENT_METADATA_SNAPSHOT]: {
    args: [runId: string]
    result: AgentMetadataSnapshot | null
  }
  [IPC.AGENT_METADATA_FIND_READY]: {
    args: [target: AgentMetadataTarget]
    result: AgentMetadataDraft | null
  }
  [IPC.AGENT_METADATA_PLAN]: {
    args: [input: AgentMetadataPlanInput]
    result: AgentMetadataReview
  }
  [IPC.AGENT_METADATA_APPLY]: {
    args: [input: AgentMetadataApplyInput]
    result: AgentMetadataApplyOutcome
  }
  [IPC.AGENT_METADATA_DISCARD]: { args: [input: AgentMetadataDiscardInput]; result: void }

  [IPC.PLAYLIST_IMPORT_START]: {
    args: [input: PlaylistImportStartInput]
    result: PlaylistImportSnapshot
  }
  [IPC.PLAYLIST_IMPORT_SNAPSHOT]: {
    args: [runId?: string]
    result: PlaylistImportSnapshot | null
  }
  [IPC.PLAYLIST_IMPORT_CONTROL]: {
    args: [runId: string, command: PlaylistImportControlCommand]
    result: PlaylistImportSnapshot
  }

  [IPC.PLAYER_PLAY]: {
    args: [libraryId: number, videoId: number]
    result: PlayResult
  }
  [IPC.PLAYER_REVEAL]: {
    args: [libraryId: number, videoId: number]
    result: PlayResult
  }
  [IPC.PLAYER_OPEN_RESOURCE]: {
    args: [libraryId: number, resourceId: number]
    result: PlayResult
  }
  [IPC.PLAYER_REVEAL_RESOURCE]: {
    args: [libraryId: number, resourceId: number]
    result: PlayResult
  }

  [IPC.ASSET_CRYPTO_SET]: { args: [enabled: boolean]; result: SettingsSnapshot }
  [IPC.ASSET_STORAGE_RELOCATE]: { args: [targetPath?: string | null]; result: SettingsSnapshot }
  [IPC.ASSET_FETCH_REMOTE_IMAGE]: { args: [url: string]; result: RemoteImagePreviewResult }
  [IPC.LLM_TRANSLATE_TO_CHINESE]: { args: [text: string]; result: string }
}

export interface AppIpcEventContract {
  [IPC.APP_UPDATE_STATE_CHANGED]: UpdateCheckState
  [IPC.SCAN_PROGRESS]: LibraryScanProgressEvent
  [IPC.SCAN_STATE_CHANGED]: LibraryScanEvent
  [IPC.PLUGIN_DEV_AGENT_EVENT]: PluginDevAgentEvent
  [IPC.ASSET_CRYPTO_PROGRESS]: AssetCryptoProgress
  [IPC.AGENT_METADATA_SNAPSHOT_CHANGED]: AgentMetadataSnapshotChangedEvent
  [IPC.PLAYLIST_IMPORT_SNAPSHOT_CHANGED]: PlaylistImportSnapshotChangedEvent
}

export type AppIpcChannel = IpcContractChannel<AppIpcContract>
export type AppIpcArgs<Channel extends AppIpcChannel> = IpcContractArgs<AppIpcContract, Channel>
export type AppIpcResult<Channel extends AppIpcChannel> = IpcContractResult<AppIpcContract, Channel>
export type AppIpcEventChannel = IpcEventChannel<AppIpcEventContract>
export type AppIpcEvent<Channel extends AppIpcEventChannel> = IpcEventPayload<AppIpcEventContract, Channel>
