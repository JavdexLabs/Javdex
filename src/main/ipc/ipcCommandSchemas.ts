import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type { ActressIpcContract } from '@shared/actressIpcContract'
import type { AppIpcContract } from '@shared/appIpcContract'
import type { ScrapeIpcContract } from '@shared/scrapeIpcContract'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import type { IpcArgsSchemaMap } from './typedIpcAdapter'

const id = z.number().int().positive()
const revision = z.number().int().nonnegative()
const finiteNumber = z.number().finite()
const text = z.string()
const nonEmptyText = z.string().min(1)
const optionalText = text.optional()
const nullableText = text.nullable()
const stringArray = z.array(text)
const idArray = z.array(id)
const record = z.record(z.string(), z.unknown())
const object = z.object({}).passthrough()
const noArgs = z.tuple([])
const sortDirection = z.enum(['asc', 'desc'])
const organizationRole = z.enum(['maker', 'publisher'])
const pluginKind = z.enum(['video', 'actress'])
const scrapeFields = z.array(text)

const videoLinkImport = z
  .object({
    code: nonEmptyText,
    url: nonEmptyText,
    kind: z.enum(['direct', 'web', 'magnet', 'ed2k']).optional(),
    displayName: nullableText.optional(),
    sizeBytes: finiteNumber.nonnegative().nullable().optional()
  })
  .strict()

const videoLinkUpdate = videoLinkImport.omit({ code: true })

const mediaImageImport = z.discriminatedUnion('source', [
  z.object({ source: z.literal('file'), sourcePath: nonEmptyText, remoteUrl: nullableText.optional() }),
  z.object({ source: z.literal('url'), sourcePath: nullableText.optional(), remoteUrl: nonEmptyText })
])

const actressDeleteRequest = z
  .object({
    ids: idArray,
    mode: z.enum(['only-unlinked', 'unlink-videos-and-delete'])
  })
  .strict()

const mergeSnapshot = z.object({}).passthrough()
const replacementMainName = z
  .object({ actressId: id, mainName: nonEmptyText })
  .strict()

const settingsPatch = z
  .object({
    libraryPaths: stringArray.optional(),
    autoDeleteResourceLessVideos: z.boolean().optional(),
    autoScanEnabled: z.boolean().optional(),
    autoScanIntervalMinutes: z.union([
      z.literal(15),
      z.literal(30),
      z.literal(60),
      z.literal(180),
      z.literal(360)
    ]).optional(),
    minScanImportDurationMinutes: finiteNumber.nonnegative().optional(),
    proxyUrl: text.optional(),
    proxyUrlEnabled: z.boolean().optional(),
    llmProxyUrl: text.optional(),
    llmProxyUrlEnabled: z.boolean().optional(),
    defaultScraper: text.optional(),
    defaultActressScraper: text.optional(),
    batchDelayMinMs: finiteNumber.nonnegative().optional(),
    batchDelayMaxMs: finiteNumber.nonnegative().optional(),
    theme: z.enum(['graphite', 'warm', 'slate', 'light']).optional(),
    privacyModeEnabled: z.boolean().optional(),
    privacyModeScopes: z.array(z.enum([
      'covers',
      'videoSamples',
      'actressGallery',
      'actressDefaultAvatar',
      'imagePreview',
      'mediaEditors',
      'globalBackground'
    ])).optional(),
    avatarFaceRatio: finiteNumber.positive().optional(),
    avatarFaceScalePreset: text.optional(),
    avatarCenteringMode: text.optional(),
    avatarPreserveFullHead: z.boolean().optional(),
    videoDetailUseFirstSampleBackground: z.boolean().optional(),
    actressDetailUseFirstGalleryBackground: z.boolean().optional(),
    showVideoResourceTypeBadges: z.boolean().optional(),
    scraperPluginDelays: object.optional(),
    compositeScrapers: object.optional(),
    defaultLlmProviderId: text.optional(),
    defaultLlmModelId: text.optional(),
    customLlmProviders: z.array(object).optional(),
    llmCustomModels: z.array(object).optional(),
    pluginDevAgentMaxSteps: finiteNumber.nonnegative().optional(),
    pluginDevAgentMaxContextTokens: finiteNumber.positive().optional()
  })
  .strict()

const llmProviderConfig = z
  .object({
    providerId: nonEmptyText,
    baseUrl: text,
    protocol: z.enum(['openai-chat', 'anthropic-messages']),
    apiKeyAction: z.enum(['keep', 'replace', 'clear']),
    apiKey: text.optional()
  })
  .strict()

const classificationEntity = z
  .object({ kind: z.enum(['organization', 'director', 'series']), id })
  .strict()

const classificationImage = z.discriminatedUnion('source', [
  z.object({ source: z.literal('file'), sourcePath: nonEmptyText }).strict(),
  z.object({ source: z.literal('url'), remoteUrl: nonEmptyText }).strict(),
  z.object({ source: z.literal('video-cover'), videoId: id }).strict()
])

const pluginPackage = z
  .object({
    schemaVersion: z.literal(1),
    kind: pluginKind,
    name: nonEmptyText,
    version: text.optional(),
    description: text.optional(),
    author: text.optional(),
    homepage: text.optional(),
    supportedFields: scrapeFields.optional(),
    code: text
  })
  .strict()

export const videoIpcSchemas = {
  [IPC.VIDEO_LIST]: z.tuple([object.optional()]),
  [IPC.VIDEO_GET]: z.tuple([id]),
  [IPC.VIDEO_UPDATE]: z.tuple([id, object]),
  [IPC.VIDEO_EDIT]: z.tuple([id, object]),
  [IPC.VIDEO_CLEAR_META]: z.tuple([id]),
  [IPC.VIDEO_MARK_SCRAPE_SUCCESS]: z.tuple([id]),
  [IPC.VIDEO_DELETE]: z.tuple([id]),
  [IPC.VIDEO_SET_RATING]: z.tuple([id, finiteNumber.min(0).max(5)]),
  [IPC.VIDEO_CORRECT_IMPORT]: z.tuple([id, nonEmptyText]),
  [IPC.VIDEO_YEARS]: noArgs,
  [IPC.VIDEO_SAMPLE_IMPORT]: z.tuple([id, mediaImageImport]),
  [IPC.VIDEO_SAMPLE_DELETE]: z.tuple([id, id]),
  [IPC.VIDEO_POSTER_SET]: z.tuple([id, nullableText]),
  [IPC.VIDEO_MANUAL_TAG_ADD]: z.tuple([id, nonEmptyText]),
  [IPC.VIDEO_MANUAL_TAG_REMOVE]: z.tuple([id, id]),
  [IPC.VIDEO_RESOURCE_IMPORT]: z.tuple([videoLinkImport]),
  [IPC.VIDEO_RESOURCE_GET]: z.tuple([id, id]),
  [IPC.VIDEO_RESOURCE_CHECK]: z.tuple([nonEmptyText]),
  [IPC.VIDEO_RESOURCE_UPDATE]: z.tuple([id, id, videoLinkUpdate]),
  [IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL]: z.tuple([id, id, nullableText]),
  [IPC.VIDEO_RESOURCE_SET_PRIMARY]: z.tuple([id, id]),
  [IPC.VIDEO_RESOURCE_REMOVE]: z.tuple([
    id,
    id,
    z.enum(['retain-video', 'delete-video']).optional()
  ])
} satisfies IpcArgsSchemaMap<VideoIpcContract>

export const actressIpcSchemas = {
  [IPC.ACTRESS_LIST]: z.tuple([
    optionalText,
    z.enum(['female', 'male', 'all']).optional(),
    z.enum(['video_count', 'gallery', 'age', 'cup_size']).optional(),
    sortDirection.optional()
  ]),
  [IPC.ACTRESS_LIST_PAGE]: z.tuple([object.optional()]),
  [IPC.ACTRESS_FACE_SCAN_MANIFEST]: noArgs,
  [IPC.ACTRESS_GET]: z.tuple([id]),
  [IPC.ACTRESS_AVATAR_SOURCE_INFO]: z.tuple([id]),
  [IPC.ACTRESS_EDIT]: z.tuple([id, object]),
  [IPC.ACTRESS_DELETE]: z.tuple([actressDeleteRequest]),
  [IPC.ACTRESS_DELETE_BATCH]: z.tuple([actressDeleteRequest]),
  [IPC.ACTRESS_DELETE_PREVIEW]: z.tuple([idArray]),
  [IPC.ACTRESS_CLEAR_META]: z.tuple([id]),
  [IPC.ACTRESS_GALLERY_IMPORT]: z.tuple([id, mediaImageImport]),
  [IPC.ACTRESS_GALLERY_DELETE]: z.tuple([id, id]),
  [IPC.ACTRESS_POSTER_SET]: z.tuple([id, nullableText]),
  [IPC.ACTRESS_MERGE]: z.tuple([
    z.object({
      keepId: id,
      mergeId: id,
      mainNameFrom: z.enum(['keep', 'merge'])
    }).strict()
  ]),
  [IPC.ACTRESS_MARK_SCRAPE_SUCCESS]: z.tuple([id]),
  [IPC.ACTRESS_CONFLICT_LIST]: noArgs,
  [IPC.ACTRESS_CONFLICT_COUNT]: noArgs,
  [IPC.ACTRESS_CONFLICT_SUMMARY]: noArgs,
  [IPC.ACTRESS_CONFLICT_INSPECT_NAME]: z.tuple([
    z.object({ actressId: id, name: nonEmptyText, pendingId: id.optional() }).strict()
  ]),
  [IPC.ACTRESS_CONFLICT_DISCARD]: z.tuple([
    z.object({ pendingId: id, expectedRevision: revision }).strict()
  ]),
  [IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL]: z.tuple([
    z.object({
      snapshot: mergeSnapshot,
      replacementMainNames: z.array(replacementMainName),
      destinationOwnerActressId: id.optional()
    }).strict()
  ]),
  [IPC.ACTRESS_CONFLICT_RESOLVE]: z.tuple([object])
} satisfies IpcArgsSchemaMap<ActressIpcContract>

const pluginUpdate = z
  .object({
    version: text.optional(),
    description: text.optional(),
    author: text.optional(),
    homepage: text.optional(),
    supportedFields: scrapeFields.optional(),
    delay: object.optional()
  })
  .strict()

const compositeScraper = z
  .object({ name: nonEmptyText, description: text.optional(), fieldPluginMap: record })
  .strict()

export const scrapeIpcSchemas = {
  [IPC.SCRAPE_ONE]: z.tuple([
    id,
    optionalText,
    scrapeFields.optional(),
    text.optional(),
    id.optional()
  ]),
  [IPC.SCRAPE_BATCH_START]: z.tuple([optionalText]),
  [IPC.SCRAPE_BATCH_CANCEL]: noArgs,
  [IPC.SCRAPE_VIDEO_BATCH_COUNT]: z.tuple([object]),
  [IPC.SCRAPE_VIDEO_BATCH_START]: z.tuple([object]),
  [IPC.SCRAPE_VIDEO_BATCH_CANCEL]: noArgs,
  [IPC.SCRAPE_REMATCH_COUNT]: z.tuple([z.enum(['scraped', 'failed', 'all'])]),
  [IPC.SCRAPE_REMATCH_BATCH_START]: z.tuple([object]),
  [IPC.SCRAPE_REMATCH_BATCH_CANCEL]: noArgs,
  [IPC.BATCH_SCRAPE_STATE]: noArgs,
  [IPC.BATCH_SCRAPE_PAUSE]: noArgs,
  [IPC.BATCH_SCRAPE_RESUME]: noArgs,
  [IPC.BATCH_SCRAPE_DISCARD]: noArgs,
  [IPC.AVATAR_AUTO_CROP_BATCH_BEGIN]: noArgs,
  [IPC.AVATAR_AUTO_CROP_BATCH_END]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_LIST]: noArgs,
  [IPC.SCRAPER_PLUGIN_DETAILS]: noArgs,
  [IPC.PLUGIN_IMPORT]: noArgs,
  [IPC.SCRAPER_PLUGIN_EXPORT]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_PLUGIN_PACKAGE]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_PLUGIN_UPDATE]: z.tuple([nonEmptyText, pluginUpdate]),
  [IPC.SCRAPER_PLUGIN_DELETE]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_COMPOSITE_CREATE]: z.tuple([compositeScraper]),
  [IPC.SCRAPER_COMPOSITE_UPDATE]: z.tuple([nonEmptyText, compositeScraper]),
  [IPC.SCRAPER_COMPOSITE_DELETE]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_SCRAPER_LIST]: noArgs,
  [IPC.ACTRESS_SCRAPER_PLUGIN_DETAILS]: noArgs,
  [IPC.ACTRESS_SCRAPER_PLUGIN_EXPORT]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_SCRAPER_PLUGIN_PACKAGE]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_SCRAPER_PLUGIN_UPDATE]: z.tuple([nonEmptyText, pluginUpdate]),
  [IPC.ACTRESS_SCRAPER_PLUGIN_DELETE]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_SCRAPER_COMPOSITE_CREATE]: z.tuple([compositeScraper]),
  [IPC.ACTRESS_SCRAPER_COMPOSITE_UPDATE]: z.tuple([nonEmptyText, compositeScraper]),
  [IPC.ACTRESS_SCRAPER_COMPOSITE_DELETE]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_SCRAPE_ONE]: z.tuple([
    id,
    optionalText,
    scrapeFields.optional(),
    text.optional(),
    optionalText,
    z.boolean().optional(),
    z.boolean().optional()
  ]),
  [IPC.ACTRESS_SCRAPE_BATCH_COUNT]: z.tuple([object]),
  [IPC.ACTRESS_SCRAPE_BATCH_START]: z.tuple([z.union([object, text]).optional()]),
  [IPC.ACTRESS_SCRAPE_BATCH_CANCEL]: noArgs,
  [IPC.ACTRESS_AVATAR_AUTO_CROP_RESULT]: z.tuple([object])
} satisfies IpcArgsSchemaMap<ScrapeIpcContract>

const profileInput = object
const listQuery = object
const mergeInput = z.object({ sourceId: id, targetId: id }).passthrough()

export const appIpcSchemas = {
  [IPC.SETTINGS_GET]: noArgs,
  [IPC.SETTINGS_UPDATE]: z.tuple([settingsPatch]),
  [IPC.SETTINGS_PICK_FOLDER]: noArgs,
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_LLM_TEST_MODEL]: z.tuple([nonEmptyText, nonEmptyText]),
  [IPC.SETTINGS_LLM_LIST_MODELS]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_LLM_PROVIDER_CONFIG_SAVE]: z.tuple([llmProviderConfig]),
  [IPC.SETTINGS_LLM_PROVIDER_DELETE]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_RECOVERY_REVEAL_BACKUP]: noArgs,
  [IPC.SETTINGS_PROXY_TEST]: z.tuple([z.enum(['scrape', 'llm']), text]),
  [IPC.SETTINGS_OVERVIEW_STATS]: noArgs,
  [IPC.APP_UPDATE_GET_STATE]: noArgs,
  [IPC.APP_UPDATE_CHECK]: noArgs,
  [IPC.APP_UPDATE_OPEN_RELEASE]: noArgs,
  [IPC.APP_UPDATE_OPEN_PROJECT_PAGE]: z.tuple([z.enum(['project', 'releases', 'license'])]),
  [IPC.EXTERNAL_LINK_OPEN]: z.tuple([nonEmptyText]),
  [IPC.APP_UPDATE_IGNORE_VERSION]: z.tuple([nonEmptyText]),
  [IPC.SCAN_RUN]: z.tuple([stringArray.optional()]),
  [IPC.SCAN_CANCEL]: noArgs,
  [IPC.FILE_RENAME]: z.tuple([nonEmptyText, nonEmptyText]),
  [IPC.FILE_IMPORT_MANUAL]: z.tuple([nonEmptyText, nonEmptyText]),
  [IPC.PLAYLIST_LIST]: noArgs,
  [IPC.PLAYLIST_GET]: z.tuple([
    id,
    z.enum(['added_at', 'release_date']).optional(),
    sortDirection.optional()
  ]),
  [IPC.PLAYLIST_CREATE]: z.tuple([profileInput]),
  [IPC.PLAYLIST_UPDATE]: z.tuple([id, profileInput]),
  [IPC.PLAYLIST_DELETE]: z.tuple([id]),
  [IPC.PLAYLIST_LIST_FOR_VIDEO]: z.tuple([id]),
  [IPC.PLAYLIST_ADD_VIDEO]: z.tuple([id, id]),
  [IPC.PLAYLIST_REMOVE_VIDEO]: z.tuple([id, id]),
  [IPC.TAG_LIST]: noArgs,
  [IPC.TAG_LIST_MANUAL]: noArgs,
  [IPC.ORGANIZATION_LIST]: z.tuple([listQuery]),
  [IPC.ORGANIZATION_GET]: z.tuple([id, organizationRole]),
  [IPC.ORGANIZATION_OPTIONS]: z.tuple([optionalText]),
  [IPC.ORGANIZATION_MERGE_OPTIONS]: z.tuple([optionalText]),
  [IPC.ORGANIZATION_CREATE]: z.tuple([profileInput]),
  [IPC.ORGANIZATION_UPDATE]: z.tuple([id, profileInput]),
  [IPC.ORGANIZATION_MERGE]: z.tuple([mergeInput]),
  [IPC.ORGANIZATION_ROLE_REMOVE_PREVIEW]: z.tuple([id, organizationRole]),
  [IPC.ORGANIZATION_ROLE_REMOVE]: z.tuple([id, organizationRole]),
  [IPC.ORGANIZATION_DELETE_PREVIEW]: z.tuple([id]),
  [IPC.ORGANIZATION_DELETE]: z.tuple([id]),
  [IPC.DIRECTOR_LIST]: z.tuple([listQuery]),
  [IPC.DIRECTOR_GET]: z.tuple([id]),
  [IPC.DIRECTOR_OPTIONS]: z.tuple([optionalText]),
  [IPC.DIRECTOR_CREATE]: z.tuple([profileInput]),
  [IPC.DIRECTOR_UPDATE]: z.tuple([id, profileInput]),
  [IPC.DIRECTOR_MERGE]: z.tuple([mergeInput]),
  [IPC.DIRECTOR_DELETE_PREVIEW]: z.tuple([id]),
  [IPC.DIRECTOR_DELETE]: z.tuple([id]),
  [IPC.SERIES_LIST]: z.tuple([listQuery]),
  [IPC.SERIES_GET]: z.tuple([id]),
  [IPC.SERIES_OPTIONS]: z.tuple([optionalText]),
  [IPC.SERIES_CREATE]: z.tuple([profileInput]),
  [IPC.SERIES_UPDATE]: z.tuple([id, profileInput]),
  [IPC.SERIES_MERGE]: z.tuple([mergeInput]),
  [IPC.SERIES_DELETE_PREVIEW]: z.tuple([id]),
  [IPC.SERIES_DELETE]: z.tuple([id]),
  [IPC.CLASSIFICATION_IMAGE_CANDIDATES]: z.tuple([classificationEntity]),
  [IPC.CLASSIFICATION_IMAGE_SET]: z.tuple([
    classificationEntity,
    classificationImage.nullable()
  ]),
  [IPC.PLUGIN_DEV_AGENT_START]: z.tuple([object]),
  [IPC.PLUGIN_DEV_AGENT_MESSAGE]: z.tuple([
    z.object({ sessionId: nonEmptyText, text, lastDryRun: object.optional() }).strict()
  ]),
  [IPC.PLUGIN_DEV_AGENT_CANCEL]: z.tuple([nonEmptyText]),
  [IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG]: z.tuple([nonEmptyText]),
  [IPC.PLUGIN_DEV_DRY_RUN]: z.tuple([
    z.object({
      package: pluginPackage,
      testTarget: text.optional(),
      testTargets: stringArray.optional()
    }).strict()
  ]),
  [IPC.PLUGIN_DEV_VERIFY]: z.tuple([object]),
  [IPC.PLUGIN_DEV_INSTALL]: z.tuple([
    z.object({ package: pluginPackage, overwriteUser: z.boolean().optional() }).strict()
  ]),
  [IPC.PLAYER_PLAY]: z.tuple([id]),
  [IPC.PLAYER_REVEAL]: z.tuple([id]),
  [IPC.PLAYER_OPEN_RESOURCE]: z.tuple([id]),
  [IPC.PLAYER_REVEAL_RESOURCE]: z.tuple([id]),
  [IPC.ASSET_CRYPTO_SET]: z.tuple([z.boolean()]),
  [IPC.ASSET_STORAGE_RELOCATE]: z.tuple([nullableText.optional()]),
  [IPC.ASSET_FETCH_REMOTE_IMAGE]: z.tuple([nonEmptyText]),
  [IPC.LLM_TRANSLATE_TO_CHINESE]: z.tuple([nonEmptyText])
} satisfies IpcArgsSchemaMap<AppIpcContract>
