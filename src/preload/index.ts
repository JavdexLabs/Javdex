import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { LlmModelDefinition } from '../shared/llmProviders'
import type { UpdateCheckState } from '../shared/updateTypes'
import type {
  AppIpcArgs,
  AppIpcChannel,
  AppIpcEvent,
  AppIpcEventChannel,
  AppIpcResult
} from '../shared/appIpcContract'
import type {
  ActressDeleteMode,
  ActressIpcArgs,
  ActressIpcChannel,
  ActressIpcResult
} from '../shared/actressIpcContract'
import type {
  ScrapeIpcArgs,
  ScrapeIpcChannel,
  ScrapeIpcEvent,
  ScrapeIpcEventChannel,
  ScrapeIpcResult
} from '../shared/scrapeIpcContract'
import type {
  VideoIpcArgs,
  VideoIpcChannel,
  VideoIpcResult
} from '../shared/videoIpcContract'
import type {
  LastVideoResourceRemovalMode,
  Video,
  VideoEditInput,
  VideoLinkResourceImportInput,
  VideoLinkResourceUpdateInput,
  VideoQuery,
  VideoSampleImportInput
} from '../shared/videoTypes'
import type {
  ActressAvatarAutoCropOutcome,
  ActressAvatarAutoCropRequest,
  ActressAvatarAutoCropResponse,
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  ActressScrapeDisposition,
  ActressScrapeField,
  ActressScrapeResult,
  ActressScrapeUpdateMode,
  CompositeScraperInput,
  ScrapeResult,
  ScraperPluginDescriptor,
  ScraperPluginPackage,
  ScraperPluginUpdateInput,
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoRematchBatchRequest,
  VideoRematchScope,
  VideoScrapeField,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode
} from '../shared/scrapeTypes'
import type { BatchProgress, BatchScrapeState } from '../shared/batchScrapeTypes'
import type { AppSettings } from '../shared/settingsTypes'
import type { LibraryOverviewStats, ScanResult, ScanProgress, PlayResult, FacetType, FacetItem, RenameImportResult, ManualImportResult, AssetCryptoProgress } from '../shared/libraryTypes'
import type { ActressAvatarSourceInfo, ActressDetail, ActressGalleryAsset, ActressGalleryImportInput, ActressEditInput, ActressGenderFilter, ActressListItem, ActressListPage, ActressListQuery, ActressListSortBy, ActressMergeInput } from '../shared/actressTypes'
import type { IpcResponse } from '../shared/ipcTypes'
import type { ActressNameConflictGroup, ActressConflictReviewSummary, InspectActressConflictNameInput, InspectActressConflictNameResult, DiscardPendingActressScrapeInput, DiscardPendingActressScrapeResult, ResolveActressConflictInput, ResolveActressConflictResult, ValidateIllegalNameReplacementsInput, ValidateIllegalNameReplacementsResult } from '../shared/actressConflictTypes'
import type { SortDir } from '../shared/commonTypes'
import type { PlaylistCreateInput, PlaylistDetail, PlaylistListItem, PlaylistUpdateInput, PlaylistVideoSortBy, PlaylistVideoMembership } from '../shared/playlistTypes'
import type { PluginDevAgentInput, PluginDevAgentEvent, PluginDevAgentMessageInput, PluginDevAgentSessionResult, PluginDevAgentStartInput, PluginDevDryRunInput, PluginDevDryRunResult, PluginDevInstallInput, PluginDevVerificationReport, PluginDevVerifyInput } from '../shared/pluginDevTypes'
import type {
  ClassificationEntityRef,
  ClassificationImageInput,
  DirectorListQuery,
  DirectorMergeInput,
  DirectorProfileInput,
  DirectorUpdateInput,
  OrganizationCreateInput,
  OrganizationListQuery,
  OrganizationMergeInput,
  OrganizationRole,
  OrganizationUpdateInput,
  SeriesListQuery,
  SeriesMergeInput,
  SeriesProfileInput,
  SeriesUpdateInput
} from '../shared/classificationTypes'

/** Helper that unwraps the IpcResponse envelope, throwing on failure. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!res.ok) throw new Error(res.error ?? 'IPC 调用失败')
  return res.data as T
}

function invokeActress<Channel extends ActressIpcChannel>(
  channel: Channel,
  ...args: ActressIpcArgs<Channel>
): Promise<ActressIpcResult<Channel>> {
  return invoke<ActressIpcResult<Channel>>(channel, ...args)
}

function invokeVideo<Channel extends VideoIpcChannel>(
  channel: Channel,
  ...args: VideoIpcArgs<Channel>
): Promise<VideoIpcResult<Channel>> {
  return invoke<VideoIpcResult<Channel>>(channel, ...args)
}

function invokeScrape<Channel extends ScrapeIpcChannel>(
  channel: Channel,
  ...args: ScrapeIpcArgs<Channel>
): Promise<ScrapeIpcResult<Channel>> {
  return invoke<ScrapeIpcResult<Channel>>(channel, ...args)
}

function invokeApp<Channel extends AppIpcChannel>(
  channel: Channel,
  ...args: AppIpcArgs<Channel>
): Promise<AppIpcResult<Channel>> {
  return invoke<AppIpcResult<Channel>>(channel, ...args)
}

function onAppEvent<Channel extends AppIpcEventChannel>(
  channel: Channel,
  callback: (payload: AppIpcEvent<Channel>) => void
): () => void {
  const listener = (_event: unknown, payload: AppIpcEvent<Channel>): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

function onScrapeEvent<Channel extends ScrapeIpcEventChannel>(
  channel: Channel,
  callback: (payload: ScrapeIpcEvent<Channel>) => void
): () => void {
  const listener = (_event: unknown, payload: ScrapeIpcEvent<Channel>): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  externalLinks: {
    open: (url: string) => invokeApp(IPC.EXTERNAL_LINK_OPEN, url)
  },
  appUpdate: {
    getState: () => invokeApp(IPC.APP_UPDATE_GET_STATE),
    check: () => invokeApp(IPC.APP_UPDATE_CHECK),
    openRelease: () => invokeApp(IPC.APP_UPDATE_OPEN_RELEASE),
    openProjectPage: (page: 'project' | 'releases' | 'license') =>
      invokeApp(IPC.APP_UPDATE_OPEN_PROJECT_PAGE, page),
    ignoreVersion: (version: string) =>
      invokeApp(IPC.APP_UPDATE_IGNORE_VERSION, version),
    onStateChanged: (cb: (state: UpdateCheckState) => void) =>
      onAppEvent(IPC.APP_UPDATE_STATE_CHANGED, cb)
  },
  settings: {
    get: () => invokeApp(IPC.SETTINGS_GET),
    update: (patch: Partial<AppSettings>) => invokeApp(IPC.SETTINGS_UPDATE, patch),
    pickFolder: () => invokeApp(IPC.SETTINGS_PICK_FOLDER),
    previewLibraryPathRemoval: (path: string) =>
      invokeApp(IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW, path),
    confirmLibraryPathRemoval: (path: string) =>
      invokeApp(IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM, path),
    testLlmModel: (providerId: string, modelId: string) =>
      invokeApp(IPC.SETTINGS_LLM_TEST_MODEL, providerId, modelId),
    listLlmModels: (providerId: string) =>
      invokeApp(IPC.SETTINGS_LLM_LIST_MODELS, providerId),
    testProxy: (kind: 'scrape' | 'llm', proxyUrl: string) =>
      invokeApp(IPC.SETTINGS_PROXY_TEST, kind, proxyUrl),
    getOverviewStats: () => invokeApp(IPC.SETTINGS_OVERVIEW_STATS)
  },
  scan: {
    run: (folders?: string[]) => invokeApp(IPC.SCAN_RUN, folders),
    cancel: () => invokeApp(IPC.SCAN_CANCEL),
    rename: (oldPath: string, newName: string) =>
      invokeApp(IPC.FILE_RENAME, oldPath, newName),
    importManual: (filePath: string, code: string) =>
      invokeApp(IPC.FILE_IMPORT_MANUAL, filePath, code),
    onProgress: (cb: (p: ScanProgress) => void) => onAppEvent(IPC.SCAN_PROGRESS, cb)
  },
  videos: {
    list: (q: VideoQuery) => invokeVideo(IPC.VIDEO_LIST, q),
    get: (id: number) => invokeVideo(IPC.VIDEO_GET, id),
    update: (id: number, fields: Partial<Video>) => invokeVideo(IPC.VIDEO_UPDATE, id, fields),
    edit: (id: number, input: VideoEditInput) => invokeVideo(IPC.VIDEO_EDIT, id, input),
    clearMeta: (id: number) => invokeVideo(IPC.VIDEO_CLEAR_META, id),
    markScrapeSuccess: (id: number) => invokeVideo(IPC.VIDEO_MARK_SCRAPE_SUCCESS, id),
    remove: (id: number) => invokeVideo(IPC.VIDEO_DELETE, id),
    setRating: (id: number, rating: number) =>
      invokeVideo(IPC.VIDEO_SET_RATING, id, rating),
    correctImport: (id: number, code: string) =>
      invokeVideo(IPC.VIDEO_CORRECT_IMPORT, id, code),
    years: () => invokeVideo(IPC.VIDEO_YEARS),
    importSample: (id: number, input: VideoSampleImportInput) =>
      invokeVideo(IPC.VIDEO_SAMPLE_IMPORT, id, input),
    deleteSample: (id: number, assetId: number) =>
      invokeVideo(IPC.VIDEO_SAMPLE_DELETE, id, assetId),
    setPoster: (id: number, posterPath: string | null) =>
      invokeVideo(IPC.VIDEO_POSTER_SET, id, posterPath),
    addManualTag: (id: number, name: string) =>
      invokeVideo(IPC.VIDEO_MANUAL_TAG_ADD, id, name),
    removeManualTag: (id: number, tagId: number) =>
      invokeVideo(IPC.VIDEO_MANUAL_TAG_REMOVE, id, tagId),
    importLinkResource: (input: VideoLinkResourceImportInput) =>
      invokeVideo(IPC.VIDEO_RESOURCE_IMPORT, input),
    getResource: (videoId: number, resourceId: number) =>
      invokeVideo(IPC.VIDEO_RESOURCE_GET, videoId, resourceId),
    checkResourceLink: (url: string) => invokeVideo(IPC.VIDEO_RESOURCE_CHECK, url),
    updateLinkResource: (
      videoId: number,
      resourceId: number,
      input: VideoLinkResourceUpdateInput
    ) => invokeVideo(IPC.VIDEO_RESOURCE_UPDATE, videoId, resourceId, input),
    updateLocalResourceLabel: (videoId: number, resourceId: number, label: string | null) =>
      invokeVideo(IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL, videoId, resourceId, label),
    setPrimaryResource: (videoId: number, resourceId: number) =>
      invokeVideo(IPC.VIDEO_RESOURCE_SET_PRIMARY, videoId, resourceId),
    removeResource: (
      videoId: number,
      resourceId: number,
      lastResourceMode?: LastVideoResourceRemovalMode
    ) => invokeVideo(IPC.VIDEO_RESOURCE_REMOVE, videoId, resourceId, lastResourceMode)
  },
  playlists: {
    list: () => invokeApp(IPC.PLAYLIST_LIST),
    get: (id: number, sortBy?: PlaylistVideoSortBy, sortDir?: SortDir) =>
      invokeApp(IPC.PLAYLIST_GET, id, sortBy, sortDir),
    create: (input: PlaylistCreateInput) => invokeApp(IPC.PLAYLIST_CREATE, input),
    update: (id: number, input: PlaylistUpdateInput) =>
      invokeApp(IPC.PLAYLIST_UPDATE, id, input),
    remove: (id: number) => invokeApp(IPC.PLAYLIST_DELETE, id),
    listForVideo: (videoId: number) =>
      invokeApp(IPC.PLAYLIST_LIST_FOR_VIDEO, videoId),
    addVideo: (playlistId: number, videoId: number) =>
      invokeApp(IPC.PLAYLIST_ADD_VIDEO, playlistId, videoId),
    removeVideo: (playlistId: number, videoId: number) =>
      invokeApp(IPC.PLAYLIST_REMOVE_VIDEO, playlistId, videoId)
  },
  actresses: {
    list: (
      search?: string,
      gender?: ActressGenderFilter,
      sortBy?: ActressListSortBy,
      sortDir?: SortDir
    ) => invokeActress(IPC.ACTRESS_LIST, search, gender, sortBy, sortDir),
    listPage: (query: ActressListQuery) => invokeActress(IPC.ACTRESS_LIST_PAGE, query),
    faceScanManifest: () => invokeActress(IPC.ACTRESS_FACE_SCAN_MANIFEST),
    get: (id: number) => invokeActress(IPC.ACTRESS_GET, id),
    getAvatarSourceInfo: (id: number) =>
      invokeActress(IPC.ACTRESS_AVATAR_SOURCE_INFO, id),
    edit: (id: number, input: ActressEditInput) => invokeActress(IPC.ACTRESS_EDIT, id, input),
    deletePreview: (ids: number[]) => invokeActress(IPC.ACTRESS_DELETE_PREVIEW, ids),
    remove: (id: number, mode: ActressDeleteMode = 'only-unlinked') =>
      invokeActress(IPC.ACTRESS_DELETE, { ids: [id], mode }),
    removeBatch: (ids: number[], mode: ActressDeleteMode = 'only-unlinked') =>
      invokeActress(IPC.ACTRESS_DELETE_BATCH, { ids, mode }),
    clearMeta: (id: number) => invokeActress(IPC.ACTRESS_CLEAR_META, id),
    importGalleryImage: (id: number, input: ActressGalleryImportInput) =>
      invokeActress(IPC.ACTRESS_GALLERY_IMPORT, id, input),
    deleteGalleryImage: (id: number, assetId: number) =>
      invokeActress(IPC.ACTRESS_GALLERY_DELETE, id, assetId),
    setPoster: (id: number, posterPath: string | null) =>
      invokeActress(IPC.ACTRESS_POSTER_SET, id, posterPath),
    merge: (input: ActressMergeInput) => invokeActress(IPC.ACTRESS_MERGE, input),
    markScrapeSuccess: (id: number) => invokeActress(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, id)
  },
  tags: {
    list: () =>
      invokeApp(IPC.TAG_LIST),
    listManual: () =>
      invokeApp(IPC.TAG_LIST_MANUAL)
  },
  facets: {
    list: (type: FacetType) => invokeApp(IPC.FACET_LIST, type),
    remove: (type: FacetType, value: string) => invokeApp(IPC.FACET_DELETE, type, value)
  },
  organizations: {
    list: (query: OrganizationListQuery) => invokeApp(IPC.ORGANIZATION_LIST, query),
    get: (id: number, role: OrganizationRole) => invokeApp(IPC.ORGANIZATION_GET, id, role),
    options: (search?: string) => invokeApp(IPC.ORGANIZATION_OPTIONS, search),
    mergeOptions: (search?: string) => invokeApp(IPC.ORGANIZATION_MERGE_OPTIONS, search),
    create: (input: OrganizationCreateInput) => invokeApp(IPC.ORGANIZATION_CREATE, input),
    update: (id: number, input: OrganizationUpdateInput) =>
      invokeApp(IPC.ORGANIZATION_UPDATE, id, input),
    merge: (input: OrganizationMergeInput) => invokeApp(IPC.ORGANIZATION_MERGE, input),
    roleRemovalPreview: (id: number, role: OrganizationRole) =>
      invokeApp(IPC.ORGANIZATION_ROLE_REMOVE_PREVIEW, id, role),
    removeRole: (id: number, role: OrganizationRole) =>
      invokeApp(IPC.ORGANIZATION_ROLE_REMOVE, id, role),
    deletePreview: (id: number) => invokeApp(IPC.ORGANIZATION_DELETE_PREVIEW, id),
    remove: (id: number) => invokeApp(IPC.ORGANIZATION_DELETE, id)
  },
  directors: {
    list: (query: DirectorListQuery) => invokeApp(IPC.DIRECTOR_LIST, query),
    get: (id: number) => invokeApp(IPC.DIRECTOR_GET, id),
    options: (search?: string) => invokeApp(IPC.DIRECTOR_OPTIONS, search),
    create: (input: DirectorProfileInput) => invokeApp(IPC.DIRECTOR_CREATE, input),
    update: (id: number, input: DirectorUpdateInput) =>
      invokeApp(IPC.DIRECTOR_UPDATE, id, input),
    merge: (input: DirectorMergeInput) => invokeApp(IPC.DIRECTOR_MERGE, input),
    deletePreview: (id: number) => invokeApp(IPC.DIRECTOR_DELETE_PREVIEW, id),
    remove: (id: number) => invokeApp(IPC.DIRECTOR_DELETE, id)
  },
  series: {
    list: (query: SeriesListQuery) => invokeApp(IPC.SERIES_LIST, query),
    get: (id: number) => invokeApp(IPC.SERIES_GET, id),
    options: (search?: string) => invokeApp(IPC.SERIES_OPTIONS, search),
    create: (input: SeriesProfileInput) => invokeApp(IPC.SERIES_CREATE, input),
    update: (id: number, input: SeriesUpdateInput) => invokeApp(IPC.SERIES_UPDATE, id, input),
    merge: (input: SeriesMergeInput) => invokeApp(IPC.SERIES_MERGE, input),
    deletePreview: (id: number) => invokeApp(IPC.SERIES_DELETE_PREVIEW, id),
    remove: (id: number) => invokeApp(IPC.SERIES_DELETE, id)
  },
  classificationImages: {
    candidates: (entity: ClassificationEntityRef) =>
      invokeApp(IPC.CLASSIFICATION_IMAGE_CANDIDATES, entity),
    set: (entity: ClassificationEntityRef, input: ClassificationImageInput | null) =>
      invokeApp(IPC.CLASSIFICATION_IMAGE_SET, entity, input)
  },
  scrape: {
    one: (
      videoId: number,
      scraperName?: string,
      fields?: VideoScrapeField[],
      mode?: VideoScrapeUpdateMode
    ) => invokeScrape(IPC.SCRAPE_ONE, videoId, scraperName, fields, mode),
    videoBatchCount: (filter: VideoBatchScrapeFilter) =>
      invokeScrape(IPC.SCRAPE_VIDEO_BATCH_COUNT, filter),
    videoBatchStart: (request: VideoBatchScrapeRequest) =>
      invokeScrape(IPC.SCRAPE_VIDEO_BATCH_START, request),
    videoBatchCancel: () => invokeScrape(IPC.SCRAPE_VIDEO_BATCH_CANCEL),
    batchStart: (scraperName?: string) => invokeScrape(IPC.SCRAPE_BATCH_START, scraperName),
    batchCancel: () => invokeScrape(IPC.SCRAPE_BATCH_CANCEL),
    rematchCount: (scope: VideoRematchScope) => invokeScrape(IPC.SCRAPE_REMATCH_COUNT, scope),
    rematchBatchStart: (request: VideoRematchBatchRequest) =>
      invokeScrape(IPC.SCRAPE_REMATCH_BATCH_START, request),
    rematchBatchCancel: () => invokeScrape(IPC.SCRAPE_REMATCH_BATCH_CANCEL),
    listPlugins: () => invokeScrape(IPC.SCRAPER_LIST),
    listPluginDetails: () => invokeScrape(IPC.SCRAPER_PLUGIN_DETAILS),
    exportPlugin: (name: string) => invokeScrape(IPC.SCRAPER_PLUGIN_EXPORT, name),
    getPluginPackage: (name: string) =>
      invokeScrape(IPC.SCRAPER_PLUGIN_PACKAGE, name),
    updatePlugin: (name: string, input: ScraperPluginUpdateInput) =>
      invokeScrape(IPC.SCRAPER_PLUGIN_UPDATE, name, input),
    deletePlugin: (name: string) => invokeScrape(IPC.SCRAPER_PLUGIN_DELETE, name),
    createComposite: (input: CompositeScraperInput) =>
      invokeScrape(IPC.SCRAPER_COMPOSITE_CREATE, input),
    updateComposite: (name: string, input: CompositeScraperInput) =>
      invokeScrape(IPC.SCRAPER_COMPOSITE_UPDATE, name, input),
    deleteComposite: (name: string) => invokeScrape(IPC.SCRAPER_COMPOSITE_DELETE, name),
    onBatchProgress: (cb: (p: BatchProgress) => void) => {
      return onScrapeEvent(IPC.SCRAPE_BATCH_PROGRESS, cb)
    },
    onVideoBatchProgress: (cb: (p: BatchProgress) => void) => {
      return onScrapeEvent(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, cb)
    },
    onRematchBatchProgress: (cb: (p: BatchProgress) => void) => {
      return onScrapeEvent(IPC.SCRAPE_REMATCH_BATCH_PROGRESS, cb)
    }
  },
  actressScrape: {
    one: (
      actressId: number,
      scraperName?: string,
      fields?: ActressScrapeField[],
      mode?: ActressScrapeUpdateMode,
      queryName?: string,
      useAliases?: boolean,
      autoCropAvatar?: boolean
    ) =>
      invokeScrape(
        IPC.ACTRESS_SCRAPE_ONE,
        actressId,
        scraperName,
        fields,
        mode,
        queryName,
        useAliases,
        autoCropAvatar
      ),
    listConflicts: () => invokeActress(IPC.ACTRESS_CONFLICT_LIST),
    conflictCount: () => invokeActress(IPC.ACTRESS_CONFLICT_COUNT),
    conflictSummary: () =>
      invokeActress(IPC.ACTRESS_CONFLICT_SUMMARY),
    inspectConflictName: (input: InspectActressConflictNameInput) =>
      invokeActress(IPC.ACTRESS_CONFLICT_INSPECT_NAME, input),
    discardConflict: (input: DiscardPendingActressScrapeInput) =>
      invokeActress(IPC.ACTRESS_CONFLICT_DISCARD, input),
    resolveConflict: (input: ResolveActressConflictInput) =>
      invokeActress(IPC.ACTRESS_CONFLICT_RESOLVE, input),
    validateIllegalNameReplacements: (input: ValidateIllegalNameReplacementsInput) =>
      invokeActress(
        IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL,
        input
      ),
    batchCount: (filter: ActressBatchScrapeFilter) =>
      invokeScrape(IPC.ACTRESS_SCRAPE_BATCH_COUNT, filter),
    batchStart: (request?: ActressBatchScrapeRequest | string) =>
      invokeScrape(IPC.ACTRESS_SCRAPE_BATCH_START, request),
    batchCancel: () => invokeScrape(IPC.ACTRESS_SCRAPE_BATCH_CANCEL),
    listPlugins: () => invokeScrape(IPC.ACTRESS_SCRAPER_LIST),
    listPluginDetails: () =>
      invokeScrape(IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS),
    exportPlugin: (name: string) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT, name),
    getPluginPackage: (name: string) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE, name),
    updatePlugin: (name: string, input: ScraperPluginUpdateInput) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE, name, input),
    deletePlugin: (name: string) => invokeScrape(IPC.ACTRESS_SCRAPER_PLUGIN_DELETE, name),
    createComposite: (input: CompositeScraperInput) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE, input),
    updateComposite: (name: string, input: CompositeScraperInput) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE, name, input),
    deleteComposite: (name: string) =>
      invokeScrape(IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE, name),
    onBatchProgress: (cb: (p: BatchProgress) => void) => {
      return onScrapeEvent(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, cb)
    },
    onAvatarAutoCropRequest: (
      cb: (request: ActressAvatarAutoCropRequest) => Promise<ActressAvatarAutoCropOutcome>
    ) => {
      return onScrapeEvent(IPC.ACTRESS_AVATAR_AUTO_CROP_REQUEST, (request) => {
        void Promise.resolve(cb(request))
          .catch(
            (error): ActressAvatarAutoCropOutcome => ({
              status: 'failed',
              message: error instanceof Error ? error.message : String(error)
            })
          )
          .then((outcome) =>
            invokeScrape(IPC.ACTRESS_AVATAR_AUTO_CROP_RESULT, {
              requestId: request.requestId,
              ...outcome
            } satisfies ActressAvatarAutoCropResponse)
          )
          .catch(() => undefined)
      })
    }
  },
  plugins: {
    importPlugin: () => invokeScrape(IPC.PLUGIN_IMPORT)
  },
  pluginDev: {
    start: (input: PluginDevAgentStartInput) =>
      invokeApp(IPC.PLUGIN_DEV_AGENT_START, input),
    message: (input: PluginDevAgentMessageInput) =>
      invokeApp(IPC.PLUGIN_DEV_AGENT_MESSAGE, input),
    cancel: (sessionId: string) => invokeApp(IPC.PLUGIN_DEV_AGENT_CANCEL, sessionId),
    exportWorkLog: (sessionId: string) =>
      invokeApp(IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG, sessionId),
    dryRun: (input: PluginDevDryRunInput) =>
      invokeApp(IPC.PLUGIN_DEV_DRY_RUN, input),
    verify: (input: PluginDevVerifyInput) =>
      invokeApp(IPC.PLUGIN_DEV_VERIFY, input),
    install: (input: PluginDevInstallInput) =>
      invokeApp(IPC.PLUGIN_DEV_INSTALL, input),
    onAgentEvent: (cb: (e: PluginDevAgentEvent) => void) =>
      onAppEvent(IPC.PLUGIN_DEV_AGENT_EVENT, cb)
  },
  batchScrape: {
    getState: () => invokeScrape(IPC.BATCH_SCRAPE_STATE),
    pause: () => invokeScrape(IPC.BATCH_SCRAPE_PAUSE),
    resume: () => invokeScrape(IPC.BATCH_SCRAPE_RESUME),
    discard: () => invokeScrape(IPC.BATCH_SCRAPE_DISCARD)
  },
  avatarAutoCropBatch: {
    begin: () => invokeScrape(IPC.AVATAR_AUTO_CROP_BATCH_BEGIN),
    end: (token: string) => invokeScrape(IPC.AVATAR_AUTO_CROP_BATCH_END, token)
  },
  player: {
    play: (videoId: number) => invokeApp(IPC.PLAYER_PLAY, videoId),
    reveal: (videoId: number) => invokeApp(IPC.PLAYER_REVEAL, videoId),
    openResource: (resourceId: number) => invokeApp(IPC.PLAYER_OPEN_RESOURCE, resourceId),
    revealResource: (resourceId: number) =>
      invokeApp(IPC.PLAYER_REVEAL_RESOURCE, resourceId)
  },
  assetCrypto: {
    setEnabled: (enabled: boolean) => invokeApp(IPC.ASSET_CRYPTO_SET, enabled),
    onProgress: (cb: (p: AssetCryptoProgress) => void) =>
      onAppEvent(IPC.ASSET_CRYPTO_PROGRESS, cb)
  },
  assetStorage: {
    relocate: (targetPath?: string | null) =>
      invokeApp(IPC.ASSET_STORAGE_RELOCATE, targetPath)
  },
  llm: {
    translateToChinese: (text: string) => invokeApp(IPC.LLM_TRANSLATE_TO_CHINESE, text)
  },
  assets: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    fetchRemoteImagePreview: (url: string) =>
      invokeApp(IPC.ASSET_FETCH_REMOTE_IMAGE, url)
  }
}

export type ElectronApi = typeof api

contextBridge.exposeInMainWorld('api', api)
