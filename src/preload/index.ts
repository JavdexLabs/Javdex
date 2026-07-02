import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AppSettings,
  LibraryOverviewStats,
  VideoQuery,
  VideoListResult,
  VideoAsset,
  VideoDetail,
  Video,
  ActressDetail,
  ActressGalleryAsset,
  ActressGalleryImportInput,
  IpcResponse,
  ScanResult,
  ScanProgress,
  BatchProgress,
  BatchScrapeState,
  PlayResult,
  ScrapeResult,
  ActressScrapeResult,
  ActressEditInput,
  ActressGenderFilter,
  ActressListItem,
  ActressListSortBy,
  ActressMergeInput,
  ListSortDir,
  PlaylistCreateInput,
  PlaylistDetail,
  PlaylistListItem,
  PlaylistUpdateInput,
  PlaylistVideoSortBy,
  PlaylistVideoSortDir,
  PlaylistVideoMembership,
  ActressBatchScrapeFilter,
  ActressBatchScrapeRequest,
  FacetType,
  FacetItem,
  VideoEditInput,
  VideoSampleImportInput,
  RenameImportResult,
  ManualImportResult,
  CorrectImportResult,
  AssetCryptoProgress,
  VideoBatchScrapeFilter,
  VideoBatchScrapeRequest,
  VideoScrapeField,
  VideoRematchBatchRequest,
  VideoRematchScope,
  VideoScrapeOneResult,
  VideoScrapeUpdateMode,
  ActressScrapeField,
  ActressScrapeUpdateMode,
  ScraperPluginDescriptor,
  ScraperPluginPackage,
  ScraperPluginUpdateInput,
  CompositeScraperInput,
  PluginDevAgentInput,
  PluginDevAgentEvent,
  PluginDevAgentMessageInput,
  PluginDevAgentSessionResult,
  PluginDevAgentStartInput,
  PluginDevDryRunInput,
  PluginDevDryRunResult,
  PluginDevInstallInput,
  PluginDevVerificationReport,
  PluginDevVerifyInput
} from '../shared/types'

/** Helper that unwraps the IpcResponse envelope, throwing on failure. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResponse<T>
  if (!res.ok) throw new Error(res.error ?? 'IPC 调用失败')
  return res.data as T
}

const api = {
  settings: {
    get: () => invoke<AppSettings>(IPC.SETTINGS_GET),
    update: (patch: Partial<AppSettings>) => invoke<AppSettings>(IPC.SETTINGS_UPDATE, patch),
    pickFolder: () => invoke<string[]>(IPC.SETTINGS_PICK_FOLDER),
    testLlmModel: (providerId: string, modelId: string) =>
      invoke<void>(IPC.SETTINGS_LLM_TEST_MODEL, providerId, modelId),
    getOverviewStats: () => invoke<LibraryOverviewStats>(IPC.SETTINGS_OVERVIEW_STATS)
  },
  scan: {
    run: (folders?: string[]) => invoke<ScanResult>(IPC.SCAN_RUN, folders),
    cancel: () => invoke<boolean>(IPC.SCAN_CANCEL),
    rename: (oldPath: string, newName: string) =>
      invoke<RenameImportResult>(IPC.FILE_RENAME, oldPath, newName),
    importManual: (filePath: string, code: string) =>
      invoke<ManualImportResult>(IPC.FILE_IMPORT_MANUAL, filePath, code),
    onProgress: (cb: (p: ScanProgress) => void) => {
      const listener = (_e: unknown, p: ScanProgress): void => cb(p)
      ipcRenderer.on(IPC.SCAN_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.SCAN_PROGRESS, listener)
      }
    }
  },
  videos: {
    list: (q: VideoQuery) => invoke<VideoListResult>(IPC.VIDEO_LIST, q),
    get: (id: number) => invoke<VideoDetail | null>(IPC.VIDEO_GET, id),
    update: (id: number, fields: Partial<Video>) => invoke<boolean>(IPC.VIDEO_UPDATE, id, fields),
    edit: (id: number, input: VideoEditInput) => invoke<boolean>(IPC.VIDEO_EDIT, id, input),
    clearMeta: (id: number) => invoke<boolean>(IPC.VIDEO_CLEAR_META, id),
    remove: (id: number) => invoke<boolean>(IPC.VIDEO_DELETE, id),
    setRating: (id: number, rating: number) =>
      invoke<boolean>(IPC.VIDEO_SET_RATING, id, rating),
    correctImport: (id: number, code: string) =>
      invoke<CorrectImportResult>(IPC.VIDEO_CORRECT_IMPORT, id, code),
    years: () => invoke<number[]>(IPC.VIDEO_YEARS),
    importSample: (id: number, input: VideoSampleImportInput) =>
      invoke<VideoAsset>(IPC.VIDEO_SAMPLE_IMPORT, id, input),
    deleteSample: (id: number, assetId: number) =>
      invoke<boolean>(IPC.VIDEO_SAMPLE_DELETE, id, assetId),
    setPoster: (id: number, posterPath: string | null) =>
      invoke<boolean>(IPC.VIDEO_POSTER_SET, id, posterPath),
    addManualTag: (id: number, name: string) =>
      invoke<boolean>(IPC.VIDEO_MANUAL_TAG_ADD, id, name),
    removeManualTag: (id: number, tagId: number) =>
      invoke<boolean>(IPC.VIDEO_MANUAL_TAG_REMOVE, id, tagId)
  },
  playlists: {
    list: () => invoke<PlaylistListItem[]>(IPC.PLAYLIST_LIST),
    get: (id: number, sortBy?: PlaylistVideoSortBy, sortDir?: PlaylistVideoSortDir) =>
      invoke<PlaylistDetail | null>(IPC.PLAYLIST_GET, id, sortBy, sortDir),
    create: (input: PlaylistCreateInput) => invoke<number>(IPC.PLAYLIST_CREATE, input),
    update: (id: number, input: PlaylistUpdateInput) =>
      invoke<boolean>(IPC.PLAYLIST_UPDATE, id, input),
    remove: (id: number) => invoke<boolean>(IPC.PLAYLIST_DELETE, id),
    listForVideo: (videoId: number) =>
      invoke<PlaylistVideoMembership[]>(IPC.PLAYLIST_LIST_FOR_VIDEO, videoId),
    addVideo: (playlistId: number, videoId: number) =>
      invoke<boolean>(IPC.PLAYLIST_ADD_VIDEO, playlistId, videoId),
    removeVideo: (playlistId: number, videoId: number) =>
      invoke<boolean>(IPC.PLAYLIST_REMOVE_VIDEO, playlistId, videoId)
  },
  actresses: {
    list: (
      search?: string,
      gender?: ActressGenderFilter,
      sortBy?: ActressListSortBy,
      sortDir?: ListSortDir
    ) => invoke<ActressListItem[]>(IPC.ACTRESS_LIST, search, gender, sortBy, sortDir),
    get: (id: number) => invoke<ActressDetail | null>(IPC.ACTRESS_GET, id),
    edit: (id: number, input: ActressEditInput) => invoke<boolean>(IPC.ACTRESS_EDIT, id, input),
    remove: (id: number) => invoke<boolean>(IPC.ACTRESS_DELETE, id),
    clearMeta: (id: number) => invoke<boolean>(IPC.ACTRESS_CLEAR_META, id),
    importGalleryImage: (id: number, input: ActressGalleryImportInput) =>
      invoke<ActressGalleryAsset>(IPC.ACTRESS_GALLERY_IMPORT, id, input),
    deleteGalleryImage: (id: number, assetId: number) =>
      invoke<boolean>(IPC.ACTRESS_GALLERY_DELETE, id, assetId),
    setPoster: (id: number, posterPath: string | null) =>
      invoke<boolean>(IPC.ACTRESS_POSTER_SET, id, posterPath),
    merge: (input: ActressMergeInput) => invoke<boolean>(IPC.ACTRESS_MERGE, input)
  },
  tags: {
    list: () =>
      invoke<Array<{ id: number; name: string; video_count: number }>>(IPC.TAG_LIST),
    listManual: () =>
      invoke<Array<{ id: number; name: string; video_count: number }>>(IPC.TAG_LIST_MANUAL)
  },
  facets: {
    list: (type: FacetType) => invoke<FacetItem[]>(IPC.FACET_LIST, type),
    remove: (type: FacetType, value: string) => invoke<boolean>(IPC.FACET_DELETE, type, value)
  },
  scrape: {
    one: (
      videoId: number,
      scraperName?: string,
      fields?: VideoScrapeField[],
      mode?: VideoScrapeUpdateMode
    ) => invoke<VideoScrapeOneResult>(IPC.SCRAPE_ONE, videoId, scraperName, fields, mode),
    videoBatchCount: (filter: VideoBatchScrapeFilter) =>
      invoke<number>(IPC.SCRAPE_VIDEO_BATCH_COUNT, filter),
    videoBatchStart: (request: VideoBatchScrapeRequest) =>
      invoke<boolean>(IPC.SCRAPE_VIDEO_BATCH_START, request),
    videoBatchCancel: () => invoke<boolean>(IPC.SCRAPE_VIDEO_BATCH_CANCEL),
    batchStart: (scraperName?: string) => invoke<boolean>(IPC.SCRAPE_BATCH_START, scraperName),
    batchCancel: () => invoke<boolean>(IPC.SCRAPE_BATCH_CANCEL),
    rematchCount: (scope: VideoRematchScope) => invoke<number>(IPC.SCRAPE_REMATCH_COUNT, scope),
    rematchBatchStart: (request: VideoRematchBatchRequest) =>
      invoke<boolean>(IPC.SCRAPE_REMATCH_BATCH_START, request),
    rematchBatchCancel: () => invoke<boolean>(IPC.SCRAPE_REMATCH_BATCH_CANCEL),
    listPlugins: () => invoke<string[]>(IPC.SCRAPER_LIST),
    listPluginDetails: () => invoke<ScraperPluginDescriptor[]>(IPC.SCRAPER_PLUGIN_DETAILS),
    exportPlugin: (name: string) => invoke<string | null>(IPC.SCRAPER_PLUGIN_EXPORT, name),
    getPluginPackage: (name: string) =>
      invoke<ScraperPluginPackage>(IPC.SCRAPER_PLUGIN_PACKAGE, name),
    updatePlugin: (name: string, input: ScraperPluginUpdateInput) =>
      invoke<ScraperPluginDescriptor>(IPC.SCRAPER_PLUGIN_UPDATE, name, input),
    deletePlugin: (name: string) => invoke<boolean>(IPC.SCRAPER_PLUGIN_DELETE, name),
    createComposite: (input: CompositeScraperInput) =>
      invoke<ScraperPluginDescriptor>(IPC.SCRAPER_COMPOSITE_CREATE, input),
    updateComposite: (name: string, input: CompositeScraperInput) =>
      invoke<ScraperPluginDescriptor>(IPC.SCRAPER_COMPOSITE_UPDATE, name, input),
    deleteComposite: (name: string) => invoke<boolean>(IPC.SCRAPER_COMPOSITE_DELETE, name),
    onBatchProgress: (cb: (p: BatchProgress) => void) => {
      const listener = (_e: unknown, p: BatchProgress): void => cb(p)
      ipcRenderer.on(IPC.SCRAPE_BATCH_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.SCRAPE_BATCH_PROGRESS, listener)
      }
    },
    onVideoBatchProgress: (cb: (p: BatchProgress) => void) => {
      const listener = (_e: unknown, p: BatchProgress): void => cb(p)
      ipcRenderer.on(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.SCRAPE_VIDEO_BATCH_PROGRESS, listener)
      }
    },
    onRematchBatchProgress: (cb: (p: BatchProgress) => void) => {
      const listener = (_e: unknown, p: BatchProgress): void => cb(p)
      ipcRenderer.on(IPC.SCRAPE_REMATCH_BATCH_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.SCRAPE_REMATCH_BATCH_PROGRESS, listener)
      }
    }
  },
  actressScrape: {
    one: (
      actressId: number,
      scraperName?: string,
      fields?: ActressScrapeField[],
      mode?: ActressScrapeUpdateMode,
      queryName?: string,
      useAliases?: boolean
    ) =>
      invoke<ActressScrapeResult>(
        IPC.ACTRESS_SCRAPE_ONE,
        actressId,
        scraperName,
        fields,
        mode,
        queryName,
        useAliases
      ),
    batchCount: (filter: ActressBatchScrapeFilter) =>
      invoke<number>(IPC.ACTRESS_SCRAPE_BATCH_COUNT, filter),
    batchStart: (request?: ActressBatchScrapeRequest | string) =>
      invoke<boolean>(IPC.ACTRESS_SCRAPE_BATCH_START, request),
    batchCancel: () => invoke<boolean>(IPC.ACTRESS_SCRAPE_BATCH_CANCEL),
    listPlugins: () => invoke<string[]>(IPC.ACTRESS_SCRAPER_LIST),
    listPluginDetails: () =>
      invoke<ScraperPluginDescriptor[]>(IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS),
    exportPlugin: (name: string) =>
      invoke<string | null>(IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT, name),
    getPluginPackage: (name: string) =>
      invoke<ScraperPluginPackage>(IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE, name),
    updatePlugin: (name: string, input: ScraperPluginUpdateInput) =>
      invoke<ScraperPluginDescriptor>(IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE, name, input),
    deletePlugin: (name: string) => invoke<boolean>(IPC.ACTRESS_SCRAPER_PLUGIN_DELETE, name),
    createComposite: (input: CompositeScraperInput) =>
      invoke<ScraperPluginDescriptor>(IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE, input),
    updateComposite: (name: string, input: CompositeScraperInput) =>
      invoke<ScraperPluginDescriptor>(IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE, name, input),
    deleteComposite: (name: string) =>
      invoke<boolean>(IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE, name),
    onBatchProgress: (cb: (p: BatchProgress) => void) => {
      const listener = (_e: unknown, p: BatchProgress): void => cb(p)
      ipcRenderer.on(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.ACTRESS_SCRAPE_BATCH_PROGRESS, listener)
      }
    }
  },
  plugins: {
    importPlugin: () => invoke<ScraperPluginDescriptor | null>(IPC.PLUGIN_IMPORT)
  },
  pluginDev: {
    start: (input: PluginDevAgentStartInput) =>
      invoke<PluginDevAgentSessionResult>(IPC.PLUGIN_DEV_AGENT_START, input),
    message: (input: PluginDevAgentMessageInput) =>
      invoke<PluginDevAgentSessionResult>(IPC.PLUGIN_DEV_AGENT_MESSAGE, input),
    cancel: (sessionId: string) => invoke<void>(IPC.PLUGIN_DEV_AGENT_CANCEL, sessionId),
    dryRun: (input: PluginDevDryRunInput) =>
      invoke<PluginDevDryRunResult>(IPC.PLUGIN_DEV_DRY_RUN, input),
    verify: (input: PluginDevVerifyInput) =>
      invoke<PluginDevVerificationReport>(IPC.PLUGIN_DEV_VERIFY, input),
    install: (input: PluginDevInstallInput) =>
      invoke<ScraperPluginDescriptor>(IPC.PLUGIN_DEV_INSTALL, input),
    onAgentEvent: (cb: (e: PluginDevAgentEvent) => void) => {
      const listener = (_e: unknown, event: PluginDevAgentEvent): void => cb(event)
      ipcRenderer.on(IPC.PLUGIN_DEV_AGENT_EVENT, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.PLUGIN_DEV_AGENT_EVENT, listener)
      }
    }
  },
  batchScrape: {
    getState: () => invoke<BatchScrapeState>(IPC.BATCH_SCRAPE_STATE),
    pause: () => invoke<boolean>(IPC.BATCH_SCRAPE_PAUSE),
    resume: () => invoke<boolean>(IPC.BATCH_SCRAPE_RESUME),
    discard: () => invoke<boolean>(IPC.BATCH_SCRAPE_DISCARD)
  },
  player: {
    play: (videoId: number) => invoke<PlayResult>(IPC.PLAYER_PLAY, videoId),
    reveal: (videoId: number) => invoke<PlayResult>(IPC.PLAYER_REVEAL, videoId)
  },
  assetCrypto: {
    setEnabled: (enabled: boolean) => invoke<AppSettings>(IPC.ASSET_CRYPTO_SET, enabled),
    onProgress: (cb: (p: AssetCryptoProgress) => void) => {
      const listener = (_e: unknown, p: AssetCryptoProgress): void => cb(p)
      ipcRenderer.on(IPC.ASSET_CRYPTO_PROGRESS, listener)
      return (): void => {
        ipcRenderer.removeListener(IPC.ASSET_CRYPTO_PROGRESS, listener)
      }
    }
  },
  assetStorage: {
    relocate: (targetPath?: string | null) =>
      invoke<AppSettings>(IPC.ASSET_STORAGE_RELOCATE, targetPath)
  },
  llm: {
    translateToChinese: (text: string) => invoke<string>(IPC.LLM_TRANSLATE_TO_CHINESE, text)
  },
  assets: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
  }
}

export type ElectronApi = typeof api

contextBridge.exposeInMainWorld('api', api)
