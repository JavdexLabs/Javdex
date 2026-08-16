// Single source of truth for IPC channel names shared between
// the preload bridge and the main-process handler registry.

export const IPC = {
  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_PICK_FOLDER: 'settings:pickFolder',
  SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW: 'settings:libraryPathRemovePreview',
  SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM: 'settings:libraryPathRemoveConfirm',
  SETTINGS_LLM_TEST_MODEL: 'settings:llmTestModel',
  SETTINGS_LLM_LIST_MODELS: 'settings:llmListModels',
  SETTINGS_LLM_PROVIDER_CONFIG_SAVE: 'settings:llmProviderConfigSave',
  SETTINGS_LLM_PROVIDER_DELETE: 'settings:llmProviderDelete',
  SETTINGS_RECOVERY_REVEAL_BACKUP: 'settings:recoveryRevealBackup',
  SETTINGS_PROXY_TEST: 'settings:proxyTest',
  SETTINGS_OVERVIEW_STATS: 'settings:overviewStats',

  // External links
  EXTERNAL_LINK_OPEN: 'externalLink:open',

  // Application release checks
  APP_UPDATE_GET_STATE: 'appUpdate:getState',
  APP_UPDATE_CHECK: 'appUpdate:check',
  APP_UPDATE_OPEN_RELEASE: 'appUpdate:openRelease',
  APP_UPDATE_OPEN_PROJECT_PAGE: 'appUpdate:openProjectPage',
  APP_UPDATE_IGNORE_VERSION: 'appUpdate:ignoreVersion',
  APP_UPDATE_STATE_CHANGED: 'appUpdate:stateChanged', // main -> renderer event

  // Scan / import
  SCAN_RUN: 'scan:run',
  SCAN_CANCEL: 'scan:cancel',
  SCAN_PROGRESS: 'scan:progress', // main -> renderer event
  FILE_RENAME: 'file:rename',
  FILE_IMPORT_MANUAL: 'file:importManual',
  PENDING_SCAN_LIST: 'pendingScan:list',
  PENDING_SCAN_RESOLVE: 'pendingScan:resolve',

  // Videos
  VIDEO_LIST: 'video:list',
  VIDEO_GET: 'video:get',
  VIDEO_UPDATE: 'video:update',
  VIDEO_EDIT: 'video:edit',
  VIDEO_CLEAR_META: 'video:clearMeta',
  VIDEO_MARK_SCRAPE_SUCCESS: 'video:markScrapeSuccess',
  VIDEO_DELETE: 'video:delete',
  VIDEO_SET_RATING: 'video:setRating',
  VIDEO_CORRECT_IMPORT: 'video:correctImport',
  VIDEO_YEARS: 'video:years',
  VIDEO_SAMPLE_IMPORT: 'video:sampleImport',
  VIDEO_SAMPLE_DELETE: 'video:sampleDelete',
  VIDEO_POSTER_SET: 'video:posterSet',
  VIDEO_MANUAL_TAG_ADD: 'video:manualTagAdd',
  VIDEO_MANUAL_TAG_REMOVE: 'video:manualTagRemove',
  VIDEO_RESOURCE_IMPORT: 'video:resourceImport',
  VIDEO_RESOURCE_GET: 'video:resourceGet',
  VIDEO_RESOURCE_CHECK: 'video:resourceCheck',
  VIDEO_RESOURCE_UPDATE: 'video:resourceUpdate',
  VIDEO_RESOURCE_UPDATE_LOCAL_LABEL: 'video:resourceUpdateLocalLabel',
  VIDEO_RESOURCE_SET_PRIMARY: 'video:resourceSetPrimary',
  VIDEO_RESOURCE_REMOVE: 'video:resourceRemove',
  VIDEO_MERGE: 'video:merge',
  VIDEO_RESOURCE_SPLIT: 'video:resourceSplit',

  // Playlists
  PLAYLIST_LIST: 'playlist:list',
  PLAYLIST_GET: 'playlist:get',
  PLAYLIST_CREATE: 'playlist:create',
  PLAYLIST_UPDATE: 'playlist:update',
  PLAYLIST_DELETE: 'playlist:delete',
  PLAYLIST_LIST_FOR_VIDEO: 'playlist:listForVideo',
  PLAYLIST_ADD_VIDEO: 'playlist:addVideo',
  PLAYLIST_REMOVE_VIDEO: 'playlist:removeVideo',

  // Actresses
  ACTRESS_LIST: 'actress:list',
  ACTRESS_LIST_PAGE: 'actress:listPage',
  ACTRESS_FACE_SCAN_MANIFEST: 'actress:faceScanManifest',
  ACTRESS_GET: 'actress:get',
  ACTRESS_AVATAR_SOURCE_INFO: 'actress:avatarSourceInfo',
  ACTRESS_EDIT: 'actress:edit',
  ACTRESS_DELETE: 'actress:delete',
  ACTRESS_DELETE_BATCH: 'actress:deleteBatch',
  ACTRESS_DELETE_PREVIEW: 'actress:deletePreview',
  ACTRESS_CLEAR_META: 'actress:clearMeta',
  ACTRESS_GALLERY_IMPORT: 'actress:galleryImport',
  ACTRESS_GALLERY_DELETE: 'actress:galleryDelete',
  ACTRESS_POSTER_SET: 'actress:posterSet',
  ACTRESS_MERGE: 'actress:merge',
  ACTRESS_MARK_SCRAPE_SUCCESS: 'actress:markScrapeSuccess',
  ACTRESS_CONFLICT_LIST: 'actressConflict:list',
  ACTRESS_CONFLICT_COUNT: 'actressConflict:count',
  ACTRESS_CONFLICT_SUMMARY: 'actressConflict:summary',
  ACTRESS_CONFLICT_INSPECT_NAME: 'actressConflict:inspectName',
  ACTRESS_CONFLICT_DISCARD: 'actressConflict:discard',
  ACTRESS_CONFLICT_VALIDATE_ILLEGAL: 'actressConflict:validateIllegal',
  ACTRESS_CONFLICT_RESOLVE: 'actressConflict:resolve',

  // Tags
  TAG_LIST: 'tag:list',
  TAG_LIST_MANUAL: 'tag:listManual',

  // Classification entities
  ORGANIZATION_LIST: 'organization:list',
  ORGANIZATION_GET: 'organization:get',
  ORGANIZATION_OPTIONS: 'organization:options',
  ORGANIZATION_MERGE_OPTIONS: 'organization:mergeOptions',
  ORGANIZATION_CREATE: 'organization:create',
  ORGANIZATION_UPDATE: 'organization:update',
  ORGANIZATION_MERGE: 'organization:merge',
  ORGANIZATION_ROLE_REMOVE_PREVIEW: 'organization:roleRemovePreview',
  ORGANIZATION_ROLE_REMOVE: 'organization:roleRemove',
  ORGANIZATION_DELETE_PREVIEW: 'organization:deletePreview',
  ORGANIZATION_DELETE: 'organization:delete',
  DIRECTOR_LIST: 'director:list',
  DIRECTOR_GET: 'director:get',
  DIRECTOR_OPTIONS: 'director:options',
  DIRECTOR_CREATE: 'director:create',
  DIRECTOR_UPDATE: 'director:update',
  DIRECTOR_MERGE: 'director:merge',
  DIRECTOR_DELETE_PREVIEW: 'director:deletePreview',
  DIRECTOR_DELETE: 'director:delete',
  SERIES_LIST: 'series:list',
  SERIES_GET: 'series:get',
  SERIES_OPTIONS: 'series:options',
  SERIES_CREATE: 'series:create',
  SERIES_UPDATE: 'series:update',
  SERIES_MERGE: 'series:merge',
  SERIES_DELETE_PREVIEW: 'series:deletePreview',
  SERIES_DELETE: 'series:delete',
  CLASSIFICATION_IMAGE_CANDIDATES: 'classificationImage:candidates',
  CLASSIFICATION_IMAGE_SET: 'classificationImage:set',

  // Scraping
  SCRAPE_ONE: 'scrape:one',
  PENDING_VIDEO_SCRAPE_LIST: 'pendingVideoScrape:list',
  PENDING_VIDEO_SCRAPE_CONFIRM: 'pendingVideoScrape:confirm',
  PENDING_VIDEO_SCRAPE_DISCARD: 'pendingVideoScrape:discard',
  SCRAPE_BATCH_START: 'scrape:batchStart',
  SCRAPE_BATCH_CANCEL: 'scrape:batchCancel',
  SCRAPE_BATCH_PROGRESS: 'scrape:batchProgress', // main -> renderer event
  SCRAPE_VIDEO_BATCH_START: 'scrape:videoBatchStart',
  SCRAPE_VIDEO_BATCH_CANCEL: 'scrape:videoBatchCancel',
  SCRAPE_VIDEO_BATCH_PROGRESS: 'scrape:videoBatchProgress', // main -> renderer event
  SCRAPE_VIDEO_BATCH_COUNT: 'scrape:videoBatchCount',
  SCRAPE_REMATCH_BATCH_START: 'scrape:rematchBatchStart',
  SCRAPE_REMATCH_BATCH_CANCEL: 'scrape:rematchBatchCancel',
  SCRAPE_REMATCH_BATCH_PROGRESS: 'scrape:rematchBatchProgress', // main -> renderer event
  SCRAPE_REMATCH_COUNT: 'scrape:rematchCount',
  BATCH_SCRAPE_STATE: 'batchScrape:state',
  BATCH_SCRAPE_PAUSE: 'batchScrape:pause',
  BATCH_SCRAPE_RESUME: 'batchScrape:resume',
  BATCH_SCRAPE_DISCARD: 'batchScrape:discard',
  AVATAR_AUTO_CROP_BATCH_BEGIN: 'avatarAutoCropBatch:begin',
  AVATAR_AUTO_CROP_BATCH_END: 'avatarAutoCropBatch:end',
  SCRAPER_LIST: 'scrape:listPlugins',
  SCRAPER_PLUGIN_DETAILS: 'scrape:pluginDetails',
  PLUGIN_IMPORT: 'plugin:import',
  SCRAPER_PLUGIN_EXPORT: 'scrape:pluginExport',
  SCRAPER_PLUGIN_PACKAGE: 'scrape:pluginPackage',
  SCRAPER_PLUGIN_UPDATE: 'scrape:pluginUpdate',
  SCRAPER_PLUGIN_DELETE: 'scrape:pluginDelete',
  SCRAPER_SERVICE_CONFIG_GET: 'scrape:serviceConfigGet',
  SCRAPER_SERVICE_CONFIG_SAVE: 'scrape:serviceConfigSave',
  SCRAPER_SERVICE_CONFIG_TEST: 'scrape:serviceConfigTest',
  SCRAPER_SERVICE_CONFIG_CLEAR: 'scrape:serviceConfigClear',
  SCRAPER_COMPOSITE_CREATE: 'scrape:compositeCreate',
  SCRAPER_COMPOSITE_UPDATE: 'scrape:compositeUpdate',
  SCRAPER_COMPOSITE_DELETE: 'scrape:compositeDelete',

  // Actress scraping (separate from video scraping)
  ACTRESS_SCRAPER_LIST: 'actressScrape:listPlugins',
  ACTRESS_SCRAPER_PLUGIN_DETAILS: 'actressScrape:pluginDetails',
  ACTRESS_SCRAPER_PLUGIN_EXPORT: 'actressScrape:pluginExport',
  ACTRESS_SCRAPER_PLUGIN_PACKAGE: 'actressScrape:pluginPackage',
  ACTRESS_SCRAPER_PLUGIN_UPDATE: 'actressScrape:pluginUpdate',
  ACTRESS_SCRAPER_PLUGIN_DELETE: 'actressScrape:pluginDelete',
  ACTRESS_SCRAPER_COMPOSITE_CREATE: 'actressScrape:compositeCreate',
  ACTRESS_SCRAPER_COMPOSITE_UPDATE: 'actressScrape:compositeUpdate',
  ACTRESS_SCRAPER_COMPOSITE_DELETE: 'actressScrape:compositeDelete',
  ACTRESS_SCRAPE_ONE: 'actressScrape:one',
  ACTRESS_SCRAPE_BATCH_COUNT: 'actressScrape:batchCount',
  ACTRESS_SCRAPE_BATCH_START: 'actressScrape:batchStart',
  ACTRESS_SCRAPE_BATCH_CANCEL: 'actressScrape:batchCancel',
  ACTRESS_SCRAPE_BATCH_PROGRESS: 'actressScrape:batchProgress', // main -> renderer event
  ACTRESS_AVATAR_AUTO_CROP_REQUEST: 'actressScrape:avatarAutoCropRequest', // main -> renderer event
  ACTRESS_AVATAR_AUTO_CROP_RESULT: 'actressScrape:avatarAutoCropResult', // renderer -> main reply

  // Plugin development agent
  PLUGIN_DEV_AGENT_START: 'pluginDev:agentStart',
  PLUGIN_DEV_AGENT_MESSAGE: 'pluginDev:agentMessage',
  PLUGIN_DEV_AGENT_CANCEL: 'pluginDev:agentCancel',
  PLUGIN_DEV_AGENT_EVENT: 'pluginDev:agentEvent', // main -> renderer event
  PLUGIN_DEV_AGENT_EXPORT_WORK_LOG: 'pluginDev:agentExportWorkLog',
  PLUGIN_DEV_DRY_RUN: 'pluginDev:dryRun',
  PLUGIN_DEV_VERIFY: 'pluginDev:verify',
  PLUGIN_DEV_INSTALL: 'pluginDev:install',

  // Player
  PLAYER_PLAY: 'player:play',
  PLAYER_REVEAL: 'player:reveal',
  PLAYER_OPEN_RESOURCE: 'player:openResource',
  PLAYER_REVEAL_RESOURCE: 'player:revealResource',

  // Asset encryption
  ASSET_CRYPTO_SET: 'assetCrypto:set',
  ASSET_CRYPTO_PROGRESS: 'assetCrypto:progress', // main -> renderer event
  ASSET_STORAGE_RELOCATE: 'assetStorage:relocate',
  ASSET_FETCH_REMOTE_IMAGE: 'asset:fetchRemoteImage',

  // LLM utilities
  LLM_TRANSLATE_TO_CHINESE: 'llm:translateToChinese'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
