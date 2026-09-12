import { SCAN_AUDIT_SECTIONS, SCAN_AUDIT_OUTCOMES } from '@shared/scanAuditReadTypes'
import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type { ActressIpcContract } from '@shared/actressIpcContract'
import { ALL_ACTRESS_SCRAPE_FIELDS } from '@shared/actressScrapeTypes'
import type { AppIpcContract } from '@shared/appIpcContract'
import type { ScrapeIpcContract } from '@shared/scrapeIpcContract'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { ALL_VIDEO_SCRAPE_FIELDS } from '@shared/videoScrapeTypes'
import type { IpcArgsSchemaMap } from './typedIpcAdapter'
import { positiveSafeInteger, videoQueryIpcSchema } from './videoQueryIpcSchema'

const scanAuditSnapshot = z.object({libraryId:positiveSafeInteger,runId:z.string().min(1).max(256),finishedAt:z.string().min(1).max(100)}).strict()
const scanAuditViewQuery = z.object({
  tab: z.enum(['failed', 'all', 'added_updated', 'skipped', 'changes']),
  outcome: z.enum(['all', ...SCAN_AUDIT_OUTCOMES]).optional(),
  changesFilter: z.enum(['all', 'removed', 'promoted', 'deleted']).optional(),
  search: z.string().max(500).optional(),
  locale: z.string().min(1).max(100).refine(value => {
    try {
      return Intl.getCanonicalLocales(value).length === 1
    } catch {
      return false
    }
  }, 'Invalid locale').optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  anchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('path'), value: z.string().min(1).max(32768) }).strict(),
    z.object({ kind: z.literal('group'), id: positiveSafeInteger }).strict()
  ]).optional()
}).strict().refine(query => query.anchor === undefined || query.tab === 'failed', 'Only failed supports anchors')

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
const playlistPageQuery = z.object({
    sortBy: z.enum(['added_at', 'release_date']).optional(),
    sortDir: sortDirection.optional(),
    resourceKinds: z.array(z.enum(['local', 'direct', 'web', 'magnet', 'ed2k', 'none'])).max(6).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict()
const organizationRole = z.enum(['maker', 'publisher'])
const pluginKind = z.enum(['video', 'actress'])
const scrapeFields = z.array(text)
const videoScrapeField = z.enum([
  'title',
  'summary',
  'cover',
  'releaseDate',
  'maker',
  'publisher',
  'series',
  'director',
  'duration',
  'actressesFemale',
  'actressesMale',
  'tags',
  'source',
  'rating',
  'samples'
])
const videoScrapeFields = z
  .array(videoScrapeField)
  .max(16)
  .refine((values) => new Set(values).size === values.length, '影片刮削字段不能重复')
const videoBatchScrapeStatus = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal('all')
])
const videoBatchScrapeFilter = z
  .object({
    libraryId: id.optional(),
    status: videoBatchScrapeStatus,
    videoIds: z
      .array(id)
      .max(10_000)
      .refine((values) => new Set(values).size === values.length, '影片 ID 不能重复')
      .optional(),
    missingFields: videoScrapeFields.optional(),
    sourceName: text.optional(),
    ratingSourceName: text.optional(),
    scraperName: text.optional()
  })
  .strict()
const videoBatchScrapeRequest = videoBatchScrapeFilter
  .extend({
    fields: videoScrapeFields.min(1),
    mode: z.enum(['replace', 'fillEmpty', 'replaceIfPresent']).optional()
  })
  .strict()
const videoResourceImportTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }).strict(),
  z.object({ kind: z.literal('existing'), videoId: id }).strict()
])
const pendingScanResolution = z
  .object({
    expectedRevision: id,
    assignments: z
      .array(
        z
          .object({
            resourceId: id,
            target: z.discriminatedUnion('kind', [
              z.object({ kind: z.literal('existing'), videoId: id }).strict(),
              z.object({ kind: z.literal('new'), groupKey: nonEmptyText.max(200) }).strict()
            ])
          })
          .strict()
      )
      .min(1)
      .max(1_000),
    primaryResourceIds: z.record(nonEmptyText.max(200), id).optional()
  })
  .strict()
const pendingResourceIdentityResolution = z
  .object({
    expectedRevision: id,
    choice: z.enum(['filename', 'nfo', 'discard'])
  })
  .strict()
const catalogScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('library'), libraryId: positiveSafeInteger }).strict(),
  z
    .object({
      kind: z.literal('all'),
      libraryIds: z
        .array(positiveSafeInteger)
        .max(500)
        .refine((values) => new Set(values).size === values.length, '媒体库 ID 不能重复')
        .optional()
    })
    .strict()
])

const videoLinkImport = z
  .object({
    libraryId: id,
    code: nonEmptyText,
    target: videoResourceImportTarget,
    url: nonEmptyText,
    kind: z.enum(['direct', 'web', 'magnet', 'ed2k']).optional(),
    displayName: nullableText.optional(),
    sizeBytes: finiteNumber.nonnegative().nullable().optional()
  })
  .strict()

const videoLinkUpdate = videoLinkImport.omit({ libraryId: true, code: true, target: true })

const lifecycleCommit = {
  operationId: nonEmptyText.max(200),
  expectedRevision: nonEmptyText
}

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
    closeToTray: z.boolean().optional(),
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
    coverDisplayMode: z.enum(['portrait', 'landscape']).optional(),
    scraperPluginDelays: object.optional(),
    compositeScrapers: object.optional()
  })
  .strict()

const workloadRuntime = z.object({
  thinkingLevel: z.enum(['minimal', 'low', 'medium', 'high']),
  maxTokens: z.number().int().nonnegative(),
  timeoutMs: z.number().int().positive(),
  cacheRetention: z.enum(['none', 'short', 'long'])
}).strict()
const workloadCompaction = z.object({
  enabled: z.boolean(),
  reserveTokens: z.number().int().nonnegative(),
  keepRecentTokens: z.number().int().nonnegative()
}).strict()
const workloadLimits = z.object({
  maxTurns: z.number().int().nonnegative(),
  maxContextTokens: z.number().int().positive()
}).strict()
const workloadSelection = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit-default') }).strict(),
  z.object({ mode: z.literal('explicit'), modelRef: nonEmptyText }).strict()
])
const capabilityState = z.union([z.boolean(), z.literal('unknown')])
const probeEvidence = z.object({
  source: z.enum(['probe', 'manual', 'migration']),
  checkedAt: nonEmptyText,
  note: text.optional()
}).strict()
const modelOverride = z.object({
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  capabilities: z.object({
    tools: capabilityState.optional(),
    vision: capabilityState.optional(),
    reasoning: capabilityState.optional()
  }).strict().optional(),
  cache: z.object({
    supportsPromptCache: capabilityState.optional(),
    supportsLongCacheRetention: z.boolean().optional(),
    cacheControlFormat: z.literal('anthropic').optional(),
    sessionAffinityFormat: z.enum(['openai', 'openai-nosession', 'openrouter']).optional(),
    sendSessionAffinityHeaders: z.boolean().optional(),
    evidence: probeEvidence
  }).strict().optional()
}).strict()
const saveConnection = z.object({
  providerId: nonEmptyText,
  name: nonEmptyText,
  source: z.enum(['builtin', 'custom']),
  protocol: z.enum(['openai-chat', 'anthropic-messages']),
  baseUrl: nonEmptyText,
  local: z.boolean().optional(),
  agentCompatible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  apiKeyAction: z.enum(['keep', 'replace', 'clear']),
  apiKey: text.optional()
}).strict()
const modelManagementCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-default-model'), modelRef: nonEmptyText }).strict(),
  z.object({
    type: z.literal('set-workload-assignment'),
    workloadId: z.enum(['plugin-developer', 'library-curator']),
    model: workloadSelection,
    runtime: workloadRuntime,
    compaction: workloadCompaction,
    limits: workloadLimits
  }).strict(),
  z.object({ type: z.literal('save-connection'), connection: saveConnection }).strict(),
  z.object({ type: z.literal('remove-connection'), connectionId: nonEmptyText }).strict(),
  z.object({
    type: z.literal('add-model'),
    connectionId: nonEmptyText,
    modelId: nonEmptyText,
    name: nonEmptyText
  }).strict(),
  z.object({ type: z.literal('remove-model'), modelRef: nonEmptyText }).strict(),
  z.object({
    type: z.literal('set-model-override'),
    modelRef: nonEmptyText,
    patch: modelOverride
  }).strict(),
  z.object({ type: z.literal('reset-model-override'), modelRef: nonEmptyText }).strict()
])
const modelManagementApply = z.object({
  expectedRevision: nonEmptyText,
  command: modelManagementCommand
}).strict()

const classificationEntity = z
  .object({ kind: z.enum(['organization', 'director', 'series']), id })
  .strict()

const classificationImage = z.discriminatedUnion('source', [
  z.object({ source: z.literal('file'), sourcePath: nonEmptyText }).strict(),
  z.object({ source: z.literal('url'), remoteUrl: nonEmptyText }).strict(),
  z.object({ source: z.literal('video-cover'), videoId: id }).strict()
])

const agentMetadataTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('video'), id }).strict(),
  z.object({ kind: z.literal('actress'), id }).strict()
])
const agentMetadataPlan = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('video'),
    draftId: nonEmptyText,
    expectedRevision: revision,
    fields: z.array(z.enum(ALL_VIDEO_SCRAPE_FIELDS)).max(ALL_VIDEO_SCRAPE_FIELDS.length),
    mode: z.enum(['replace', 'fillEmpty', 'replaceIfPresent']),
    directorSelectionId: id.optional()
  }).strict(),
  z.object({
    kind: z.literal('actress'),
    draftId: nonEmptyText,
    expectedRevision: revision,
    fields: z.array(z.enum(ALL_ACTRESS_SCRAPE_FIELDS)).max(ALL_ACTRESS_SCRAPE_FIELDS.length),
    mode: z.enum(['replace', 'fillEmpty', 'replaceIfPresent']),
    identityConfirmed: z.boolean().optional()
  }).strict()
])

const playlistImportDestination = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    requestedName: text.max(500).optional()
  }).strict(),
  z.object({ kind: z.literal('append'), playlistId: id }).strict()
])
const playlistImportStart = z.object({
  idempotencyKey: nonEmptyText.max(200),
  sourceUrl: nonEmptyText.max(4_096),
  targetLibraryId: id,
  destination: playlistImportDestination,
  autoCreateUnmatchedVideos: z.boolean().optional().default(true),
  saveDetailLinks: z.boolean().optional().default(true),
  saveSourcePlaylistLink: z.boolean().optional().default(false)
}).strict()
const playlistImportControl = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('resume-browser'),
    requestId: nonEmptyText.max(500),
    idempotencyKey: nonEmptyText.max(200)
  }).strict(),
  z.object({
    kind: z.literal('retry'),
    expectedRevision: revision,
    idempotencyKey: nonEmptyText.max(200)
  }).strict(),
  z.object({
    kind: z.literal('resolve-identities'),
    expectedRevision: revision,
    idempotencyKey: nonEmptyText.max(200),
    decisions: z.array(z.object({
      itemId: id,
      choice: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('existing'), videoId: id }).strict(),
        z.object({ kind: z.literal('create') }).strict()
      ])
    }).strict()).min(1).max(500)
  }).strict(),
  z.object({
    kind: z.literal('cancel'),
    idempotencyKey: nonEmptyText.max(200)
  }).strict()
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

const classificationPageQuery = z.object({
  search: z.string().optional(),
  sortBy: z.enum(['video_count', 'updated_at']).optional(),
  sortDir: z.enum(['asc','desc']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
}).strict()

export const videoIpcSchemas = {
  [IPC.VIDEO_LIST]: z.tuple([catalogScope, videoQueryIpcSchema.optional()]),
  [IPC.VIDEO_GET]: z.tuple([catalogScope, positiveSafeInteger]),
  [IPC.VIDEO_UPDATE]: z.tuple([id, object]),
  [IPC.VIDEO_EDIT]: z.tuple([id, object]),
  [IPC.VIDEO_CLEAR_META]: z.tuple([id]),
  [IPC.VIDEO_MARK_SCRAPE_SUCCESS]: z.tuple([id]),
  [IPC.VIDEO_SET_RATING]: z.tuple([id, finiteNumber.min(0).max(5)]),
  [IPC.VIDEO_CORRECT_IMPORT]: z.tuple([id, nonEmptyText, z.boolean().optional()]),
  [IPC.VIDEO_YEARS]: z.tuple([catalogScope]),
  [IPC.VIDEO_SAMPLE_IMPORT]: z.tuple([id, mediaImageImport]),
  [IPC.VIDEO_SAMPLE_DELETE]: z.tuple([id, id]),
  [IPC.VIDEO_POSTER_SET]: z.tuple([id, nullableText]),
  [IPC.VIDEO_MANUAL_TAG_ADD]: z.tuple([id, nonEmptyText]),
  [IPC.VIDEO_MANUAL_TAG_ADD_EXISTING]: z.tuple([positiveSafeInteger, positiveSafeInteger]),
  [IPC.VIDEO_MANUAL_TAG_REMOVE]: z.tuple([id, id]),
  [IPC.VIDEO_RESOURCE_IMPORT]: z.tuple([videoLinkImport]),
  [IPC.VIDEO_RESOURCE_GET]: z.tuple([id, id, id]),
  [IPC.VIDEO_RESOURCE_CHECK]: z.tuple([nonEmptyText]),
  [IPC.VIDEO_RESOURCE_UPDATE]: z.tuple([id, id, id, videoLinkUpdate]),
  [IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL]: z.tuple([id, id, id, nullableText]),
  [IPC.VIDEO_RESOURCE_SET_PRIMARY]: z.tuple([id, id, id]),
  [IPC.VIDEO_RESOURCE_REMOVE]: z.tuple([
    id,
    id,
    id,
    z.literal('retain-video').optional()
  ]),
  [IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW]: z.tuple([id, id]),
  [IPC.VIDEO_REMOVE_FROM_LIBRARY]: z.tuple([
    z.object({
      ...lifecycleCommit,
      libraryId: id,
      videoId: id
    }).strict()
  ]),
  [IPC.VIDEO_RESOURCE_MOVE_PREVIEW]: z.tuple([id, id, id]),
  [IPC.VIDEO_RESOURCE_MOVE]: z.tuple([
    z.object({
      ...lifecycleCommit,
      sourceLibraryId: id,
      targetLibraryId: id,
      resourceId: id
    }).strict()
  ]),
  [IPC.VIDEO_DELETE_GLOBAL_PREVIEW]: z.tuple([id]),
  [IPC.VIDEO_DELETE_GLOBAL]: z.tuple([
    z.object({
      ...lifecycleCommit,
      videoId: id
    }).strict()
  ]),
  [IPC.VIDEO_MERGE]: z.tuple([
    z.object({ retainedVideoId: id, sourceVideoId: id }).strict()
  ]),
  [IPC.VIDEO_RESOURCE_SPLIT]: z.tuple([id, id, id])
} satisfies IpcArgsSchemaMap<VideoIpcContract>

export const actressIpcSchemas = {
  [IPC.ACTRESS_MERGE_CANDIDATES]: z.tuple([z.object({
    keepId: positiveSafeInteger,
    search: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict()]),
  [IPC.ACTRESS_AVATAR_CROP_TARGETS]: z.tuple([]),
  [IPC.ACTRESS_AVATAR_CROP_COUNT]: z.tuple([]),
  [IPC.ACTRESS_TEST_TARGET_GET]: z.tuple([positiveSafeInteger]),
  [IPC.ACTRESS_TEST_TARGET_PAGE]: z.tuple([z.object({
    search: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional()]),
  [IPC.ACTRESS_PICKER_GET]: z.tuple([positiveSafeInteger]),
  [IPC.ACTRESS_PICKER_PAGE]: z.tuple([z.object({
    search: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional()]),
  [IPC.ACTRESS_LIST]: z.tuple([
    optionalText,
    z.enum(['female', 'male', 'all']).optional(),
    z.enum(['video_count', 'gallery', 'age', 'cup_size']).optional(),
    sortDirection.optional()
  ]),
  [IPC.ACTRESS_LIST_PAGE]: z.tuple([object.optional()]),
  [IPC.ACTRESS_FACE_SCAN_MANIFEST]: noArgs,
  [IPC.ACTRESS_GALLERY_PAGE]: z.tuple([positiveSafeInteger, z.object({
    anchorId: positiveSafeInteger.optional(),
    localOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional()]),
  [IPC.ACTRESS_PROFILE]: z.tuple([positiveSafeInteger]),
  [IPC.ACTRESS_METADATA]: z.tuple([positiveSafeInteger]),
  [IPC.ACTRESS_VIDEO_PAGE]: z.tuple([positiveSafeInteger, z.object({
    withCover: z.boolean().optional(),
    limit: z.number().int().min(1).max(240).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional()]),
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
  [IPC.ACTRESS_CONFLICT_GET]: z.tuple([nonEmptyText]),
  [IPC.ACTRESS_CONFLICT_QUEUE_PAGE]: z.tuple([z.object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    anchorName: nonEmptyText.optional()
  }).strict()]),
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

const scraperServiceId = z.literal('metatube')
const scraperServiceTokenUpdate = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }).strict(),
  z.object({ mode: z.literal('set'), value: nonEmptyText }).strict(),
  z.object({ mode: z.literal('clear') }).strict()
])
const scraperServiceConfig = z
  .object({
    serverUrl: text,
    useScrapeProxy: z.boolean(),
    tokenUpdate: scraperServiceTokenUpdate,
    acknowledgeInsecureHttp: z.boolean().optional()
  })
  .strict()

export const scrapeIpcSchemas = {
  [IPC.SCRAPE_ONE]: z.tuple([
    id,
    optionalText,
    videoScrapeFields.optional(),
    z.enum(['replace', 'fillEmpty', 'replaceIfPresent']).optional(),
    id.optional(),
    id.optional()
  ]),
  [IPC.PENDING_VIDEO_SCRAPE_COUNT]: noArgs,
  [IPC.PENDING_VIDEO_SCRAPE_EXISTING_IDS]: z.tuple([z.array(id.max(Number.MAX_SAFE_INTEGER)).max(100)]),
  [IPC.PENDING_VIDEO_SCRAPE_PAGE]: z.tuple([z.object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    anchorId: id.max(Number.MAX_SAFE_INTEGER).optional(), videoId: id.max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().refine(value => value.anchorId === undefined || value.videoId === undefined)]),
  [IPC.PENDING_VIDEO_SCRAPE_GET]: z.tuple([id.max(Number.MAX_SAFE_INTEGER)]),
  [IPC.PENDING_VIDEO_SCRAPE_LIST]: noArgs,
  [IPC.PENDING_VIDEO_SCRAPE_CONFIRM]: z.tuple([
    z.object({
      pendingScrapeId: id,
      selections: z.array(z.object({ sourceId: id, candidateId: id }).strict()),
      directorSelectionId: id.optional(),
      mergeRetainedVideoId: id.optional()
    }).strict()
  ]),
  [IPC.PENDING_VIDEO_SCRAPE_DISCARD]: z.tuple([id]),
  [IPC.SCRAPE_BATCH_START]: z.tuple([optionalText]),
  [IPC.SCRAPE_BATCH_CANCEL]: noArgs,
  [IPC.SCRAPE_VIDEO_BATCH_COUNT]: z.tuple([videoBatchScrapeFilter]),
  [IPC.SCRAPE_VIDEO_BATCH_START]: z.tuple([videoBatchScrapeRequest]),
  [IPC.SCRAPE_VIDEO_BATCH_CANCEL]: noArgs,
  [IPC.SCRAPE_REMATCH_COUNT]: z.tuple([z.enum(['scraped', 'failed', 'all'])]),
  [IPC.SCRAPE_REMATCH_BATCH_START]: z.tuple([object]),
  [IPC.SCRAPE_REMATCH_BATCH_CANCEL]: noArgs,
  [IPC.BATCH_SCRAPE_STATE]: noArgs,
  [IPC.BATCH_SCRAPE_PAUSE]: noArgs,
  [IPC.BATCH_SCRAPE_RESUME]: noArgs,
  [IPC.BATCH_SCRAPE_DISCARD]: noArgs,
  [IPC.AVATAR_AUTO_CROP_BATCH_BEGIN]: noArgs,
  [IPC.AVATAR_AUTO_CROP_BATCH_TARGETS]: z.tuple([nonEmptyText, z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]),
  [IPC.AVATAR_AUTO_CROP_BATCH_END]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_LIST]: noArgs,
  [IPC.SCRAPER_PLUGIN_DETAILS]: noArgs,
  [IPC.PLUGIN_IMPORT]: noArgs,
  [IPC.SCRAPER_PLUGIN_EXPORT]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_PLUGIN_PACKAGE]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_PLUGIN_UPDATE]: z.tuple([nonEmptyText, pluginUpdate]),
  [IPC.SCRAPER_PLUGIN_DELETE]: z.tuple([nonEmptyText]),
  [IPC.SCRAPER_SERVICE_CONFIG_GET]: z.tuple([scraperServiceId]),
  [IPC.SCRAPER_SERVICE_CONFIG_SAVE]: z.tuple([scraperServiceId, scraperServiceConfig]),
  [IPC.SCRAPER_SERVICE_CONFIG_TEST]: z.tuple([scraperServiceId, scraperServiceConfig]),
  [IPC.SCRAPER_SERVICE_CONFIG_CLEAR]: z.tuple([scraperServiceId]),
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
  [IPC.WEB_ACCESS_PAIR_OPEN]: noArgs,
  [IPC.WEB_ACCESS_PAIR_INSPECT]: z.tuple([z.string().regex(/^\d{6}$/)]),
  [IPC.WEB_ACCESS_PAIR_DECIDE]: z.tuple([z.string().regex(/^\d{6}$/), z.boolean()]),
  [IPC.WEB_ACCESS_DEVICE_REMOVE]: z.tuple([z.string().regex(/^[a-f0-9]{32}$/)]),
  [IPC.WEB_ACCESS_DEVICE_RENAME]: z.tuple([z.string().regex(/^[a-f0-9]{32}$/), z.string().trim().min(1).max(80)]),
  [IPC.WEB_ACCESS_DEVICE_RESET]: noArgs,
  [IPC.WEB_ACCESS_STATUS]: noArgs,
  [IPC.WEB_ACCESS_REVOKE]: noArgs,
  [IPC.WEB_ACCESS_APPLY]: z.tuple([z.object({
    enabled: z.boolean(), port: z.number().int().min(1024).max(65535),
    username: z.string().regex(/^[\w.-]{1,64}$/), password: z.string().min(12).max(128).optional()
  }).strict()]),
  [IPC.SETTINGS_GET]: noArgs,
  [IPC.SETTINGS_UPDATE]: z.tuple([settingsPatch]),
  [IPC.SETTINGS_PICK_FOLDER]: noArgs,
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_PREVIEW]: z.tuple([id, id]),
  [IPC.SETTINGS_LIBRARY_PATH_REMOVE_CONFIRM]: z.tuple([
    id,
    id,
    id,
    z.string().regex(/^[a-f0-9]{64}$/)
  ]),
  [IPC.SETTINGS_MODEL_MANAGEMENT_GET]: noArgs,
  [IPC.SETTINGS_MODEL_MANAGEMENT_APPLY]: z.tuple([modelManagementApply]),
  [IPC.SETTINGS_MODEL_MANAGEMENT_DISCOVER_MODELS]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_MODEL_MANAGEMENT_TEST_MODEL]: z.tuple([nonEmptyText]),
  [IPC.SETTINGS_RECOVERY_REVEAL_BACKUP]: noArgs,
  [IPC.SETTINGS_PROXY_TEST]: z.tuple([z.enum(['scrape', 'llm']), text]),
  [IPC.SETTINGS_OVERVIEW_STATS]: noArgs,
  [IPC.APP_UPDATE_GET_STATE]: noArgs,
  [IPC.APP_UPDATE_CHECK]: noArgs,
  [IPC.APP_UPDATE_OPEN_RELEASE]: noArgs,
  [IPC.APP_UPDATE_OPEN_PROJECT_PAGE]: z.tuple([z.enum(['project', 'releases', 'license'])]),
  [IPC.EXTERNAL_LINK_OPEN]: z.tuple([nonEmptyText]),
  [IPC.APP_UPDATE_IGNORE_VERSION]: z.tuple([nonEmptyText]),
  [IPC.SCAN_RUN]: z.tuple([
    id,
    z
      .array(id)
      .max(64)
      .refine((values) => new Set(values).size === values.length, '根目录 ID 不能重复')
      .optional()
  ]),
  [IPC.SCAN_CANCEL]: z.tuple([nonEmptyText]),
  [IPC.SCAN_LATEST_GET]: z.tuple([id]),
  [IPC.SCAN_AUDIT_GET]: z.tuple([id]),
  [IPC.SCAN_AUDIT_HEADER]: z.tuple([positiveSafeInteger]),
  [IPC.SCAN_AUDIT_PAGE]: z.tuple([
    scanAuditSnapshot,
    z.object({section:z.enum(SCAN_AUDIT_SECTIONS),outcome:z.enum(SCAN_AUDIT_OUTCOMES).optional(),attention:z.boolean().optional(),
      limit:z.number().int().min(1).max(100).optional(),offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
    }).strict().refine(query=>query.section==='files'||(query.outcome===undefined&&query.attention===undefined),'Only files support outcome and attention filters')
  ]),
  [IPC.SCAN_AUDIT_VIEW_PAGE]: z.tuple([scanAuditSnapshot, scanAuditViewQuery]),
  [IPC.SCAN_AUDIT_REVEAL_FILE]: z.tuple([id, nonEmptyText]),
  [IPC.FILE_RENAME]: z.tuple([
    id,
    id,
    nonEmptyText,
    nonEmptyText
  ]),
  [IPC.FILE_IMPORT_MANUAL]: z.tuple([
    id,
    id,
    nonEmptyText,
    nonEmptyText,
    videoResourceImportTarget
  ]),
  [IPC.PENDING_AUDIT_PRESENCE]: z.tuple([id.max(Number.MAX_SAFE_INTEGER),z.object({
    groupIds:z.array(id.max(Number.MAX_SAFE_INTEGER)).max(100),
    identityIds:z.array(id.max(Number.MAX_SAFE_INTEGER)).max(100),
    scrapeIds:z.array(id.max(Number.MAX_SAFE_INTEGER)).max(100)
  }).strict().refine(value => value.groupIds.length + value.identityIds.length + value.scrapeIds.length <= 100)]),
  [IPC.PENDING_SCAN_QUEUE_PAGE]: z.tuple([z.object({
    libraryId:id.max(Number.MAX_SAFE_INTEGER).optional(), limit:z.number().int().min(1).max(100).optional(),
    offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    anchor:z.object({kind:z.enum(['group','identity']),id:id.max(Number.MAX_SAFE_INTEGER)}).strict().optional()
  }).strict()]),
  [IPC.PENDING_SCAN_QUEUE_COUNT]: z.tuple([id.max(Number.MAX_SAFE_INTEGER).optional()]),
  [IPC.PENDING_SCAN_GET]: z.tuple([id.max(Number.MAX_SAFE_INTEGER),id.max(Number.MAX_SAFE_INTEGER)]),
  [IPC.PENDING_RESOURCE_IDENTITY_GET]: z.tuple([id.max(Number.MAX_SAFE_INTEGER),id.max(Number.MAX_SAFE_INTEGER)]),
  [IPC.PENDING_SCAN_LIST]: z.tuple([id]),
  [IPC.PENDING_SCAN_RESOLVE]: z.tuple([id, id, pendingScanResolution]),
  [IPC.PENDING_RESOURCE_IDENTITY_LIST]: z.tuple([id]),
  [IPC.PENDING_RESOURCE_IDENTITY_RESOLVE]: z.tuple([
    id,
    id,
    pendingResourceIdentityResolution
  ]),
  [IPC.PLAYLIST_LIST_PAGE]: z.tuple([z.object({
    search: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), videoId: positiveSafeInteger.optional(),
    locale: z.string().min(1).max(100).refine(value => { try { Intl.getCanonicalLocales(value); return true } catch { return false } }).optional()
  }).strict()]),
  [IPC.PLAYLIST_LIST]: noArgs,
  [IPC.PLAYLIST_GET]: z.tuple([
    id,
    z.enum(['added_at', 'release_date']).optional(),
    sortDirection.optional()
  ]),
  [IPC.PLAYLIST_VIDEO_PAGE]: z.tuple([id, playlistPageQuery]),
  [IPC.PLAYLIST_METADATA]: z.tuple([id, z.enum(['added_at', 'release_date']).optional(), sortDirection.optional()]),
  [IPC.PLAYLIST_GET_PAGE]: z.tuple([id, playlistPageQuery]),
  [IPC.PLAYLIST_CREATE]: z.tuple([profileInput]),
  [IPC.PLAYLIST_UPDATE]: z.tuple([id, profileInput]),
  [IPC.PLAYLIST_DELETE]: z.tuple([id]),
  [IPC.PLAYLIST_LIST_FOR_VIDEO]: z.tuple([id]),
  [IPC.PLAYLIST_ADD_VIDEO]: z.tuple([id, id]),
  [IPC.PLAYLIST_REMOVE_VIDEO]: z.tuple([id, id]),
  [IPC.TAG_LIST]: noArgs,
  [IPC.TAG_LIST_MANUAL]: noArgs,
  [IPC.TAG_LABELS]: z.tuple([z.array(positiveSafeInteger).max(100)]),
  [IPC.TAG_FILTER_OPTIONS]: z.tuple([z.object({
    search: z.string().max(500).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict()]),
  [IPC.TAG_MANUAL_OPTIONS]: z.tuple([z.object({
    search: z.string().max(500).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict()]),
  [IPC.ORGANIZATION_PAGE]: z.tuple([classificationPageQuery.extend({role: z.enum(['maker','publisher'])})]),
  [IPC.SERIES_PAGE]: z.tuple([classificationPageQuery]),
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
  [IPC.DIRECTOR_PAGE]: z.tuple([classificationPageQuery]),
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
  [IPC.CLASSIFICATION_IMAGE_PAGE]: z.tuple([classificationEntity.extend({id: positiveSafeInteger}), z.object({
    limit: z.number().int().min(1).max(100).optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional()]),
  [IPC.CLASSIFICATION_IMAGE_CANDIDATES]: z.tuple([classificationEntity]),
  [IPC.CLASSIFICATION_IMAGE_SET]: z.tuple([
    classificationEntity,
    classificationImage.nullable()
  ]),
  [IPC.PLUGIN_DEV_AGENT_START]: z.tuple([object]),
  [IPC.PLUGIN_DEV_AGENT_MESSAGE]: z.tuple([
    z.object({
      sessionId: nonEmptyText,
      text,
      continuationKind: z.enum(['resume', 'user_feedback']).optional(),
      approvalDecision: z.object({
        requestId: nonEmptyText,
        decision: z.enum(['approve', 'deny'])
      }).strict().optional(),
      userResponse: z.discriminatedUnion('type', [
        z.object({
          requestId: nonEmptyText,
          type: z.literal('browser_interaction'),
          action: z.literal('completed')
        }).strict(),
        z.object({
          requestId: nonEmptyText,
          type: z.literal('freeform'),
          text: nonEmptyText
        }).strict(),
        z.object({
          requestId: nonEmptyText,
          type: z.literal('choice'),
          optionId: nonEmptyText
        }).strict()
      ]).optional()
    }).strict()
  ]),
  [IPC.PLUGIN_DEV_AGENT_CANCEL]: z.tuple([nonEmptyText]),
  [IPC.PLUGIN_DEV_AGENT_RELEASE_BROWSER]: z.tuple([nonEmptyText]),
  [IPC.PLUGIN_DEV_AGENT_SNAPSHOT]: z.tuple([nonEmptyText.optional()]),
  [IPC.PLUGIN_DEV_AGENT_CLEAR_HISTORY]: z.tuple([]),
  [IPC.PLUGIN_DEV_AGENT_DISCARD_UNRECOVERABLE]: z.tuple([]),
  [IPC.PLUGIN_DEV_AGENT_EXPORT_WORK_LOG]: z.tuple([nonEmptyText]),
  [IPC.PLUGIN_DEV_DRY_RUN]: z.tuple([
    z.object({
      package: pluginPackage,
      testTarget: text.optional(),
      testTargets: stringArray.optional()
    }).strict()
  ]),
  [IPC.PLUGIN_DEV_INSTALL]: z.tuple([
    z.object({
      package: pluginPackage,
      overwriteUser: z.boolean().optional(),
      sessionId: nonEmptyText.optional()
    }).strict()
  ]),
  [IPC.LIBRARY_CURATOR_START]: z.tuple([
    z.object({ prompt: text.optional() }).strict().optional()
  ]),
  [IPC.LIBRARY_CURATOR_MESSAGE]: z.tuple([
    z.object({ runId: nonEmptyText, text: nonEmptyText }).strict()
  ]),
  [IPC.LIBRARY_CURATOR_CANCEL]: z.tuple([nonEmptyText]),
  [IPC.LIBRARY_CURATOR_SNAPSHOT]: z.tuple([nonEmptyText.optional()]),
  [IPC.AGENT_METADATA_START]: z.tuple([
    z.object({
      target: agentMetadataTarget,
      sourceUrl: nonEmptyText.max(4_096),
      idempotencyKey: nonEmptyText.max(200)
    }).strict()
  ]),
  [IPC.AGENT_METADATA_RESUME]: z.tuple([
    z.object({
      runId: nonEmptyText,
      requestId: nonEmptyText,
      idempotencyKey: nonEmptyText.max(200)
    }).strict()
  ]),
  [IPC.AGENT_METADATA_CANCEL]: z.tuple([nonEmptyText]),
  [IPC.AGENT_METADATA_SNAPSHOT]: z.tuple([nonEmptyText]),
  [IPC.AGENT_METADATA_FIND_READY]: z.tuple([agentMetadataTarget]),
  [IPC.AGENT_METADATA_PLAN]: z.tuple([agentMetadataPlan]),
  [IPC.AGENT_METADATA_APPLY]: z.tuple([
    z.object({
      draftId: nonEmptyText,
      reviewToken: nonEmptyText,
      idempotencyKey: nonEmptyText.max(200)
    }).strict()
  ]),
  [IPC.AGENT_METADATA_DISCARD]: z.tuple([
    z.object({ draftId: nonEmptyText, expectedRevision: revision }).strict()
  ]),
  [IPC.PLAYLIST_IMPORT_START]: z.tuple([playlistImportStart]),
  [IPC.PLAYLIST_IMPORT_SNAPSHOT]: z.tuple([nonEmptyText.optional()]),
  [IPC.PLAYLIST_IMPORT_CONTROL]: z.tuple([nonEmptyText, playlistImportControl]),
  [IPC.PLAYER_PLAY]: z.tuple([id, id]),
  [IPC.PLAYER_REVEAL]: z.tuple([id, id]),
  [IPC.PLAYER_OPEN_RESOURCE]: z.tuple([id, id]),
  [IPC.PLAYER_REVEAL_RESOURCE]: z.tuple([id, id]),
  [IPC.ASSET_CRYPTO_SET]: z.tuple([z.boolean()]),
  [IPC.ASSET_STORAGE_RELOCATE]: z.tuple([nullableText.optional()]),
  [IPC.ASSET_FETCH_REMOTE_IMAGE]: z.tuple([nonEmptyText]),
  [IPC.LLM_TRANSLATE_TO_CHINESE]: z.tuple([nonEmptyText])
} satisfies IpcArgsSchemaMap<AppIpcContract>
