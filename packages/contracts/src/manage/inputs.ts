import { z } from 'zod'
import { ALL_VIDEO_SCRAPE_FIELDS } from '../videoScrapeTypes'
import { NFO_EXPORT_PROFILE_IDS } from '../nfoExportTypes'
import { DIRECT_ID_BATCH_MAX, PAGE_SIZE_MAX } from '../protocol/limits'
import type { ManageOperationId } from './operations'
import {
  catalogImageRefSchema,
  catalogScopeSchema,
  codeSchema,
  digestSchema,
  directorAssignmentSchema,
  idListSchema,
  idSchema,
  imageContentTypeSchema,
  limitedTextSchema,
  mountSelectionSchema,
  organizationAssignmentSchema,
  pageQuerySchema,
  relatedLinksSchema,
  searchTextSchema,
  seriesAssignmentSchema,
  sortDirSchema,
  tagNameSchema,
  tagNamesSchema,
  uploadPurposeSchema,
  uuidSchema
} from './primitives'

const emptyInput = z.object({}).strict()
const videoScrapeFieldSchema = z.enum(
  ALL_VIDEO_SCRAPE_FIELDS as unknown as [string, ...string[]]
)
const videoScrapeFieldsSchema = z
  .array(videoScrapeFieldSchema)
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length, 'scrape fields must be unique')
const scrapeModeSchema = z.enum(['replace', 'fillEmpty', 'replaceIfPresent'])
const resourceFilterSchema = z.enum(['local', 'direct', 'web', 'magnet', 'ed2k', 'none'])
const lastResourceModeSchema = z.enum(['retain-video'])
const scrapedStatusSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal('all')])
const videoQuerySchema = z
  .object({
    search: searchTextSchema.optional(),
    scrapedStatus: scrapedStatusSchema.optional(),
    minRating: z.number().min(0).max(5).optional(),
    year: z.union([z.number().int(), z.literal('all')]).optional(),
    actressId: idSchema.optional(),
    tagId: idSchema.optional(),
    tagIds: idListSchema.optional(),
    makerOrganizationId: idSchema.optional(),
    publisherOrganizationId: idSchema.optional(),
    seriesId: idSchema.optional(),
    directorId: idSchema.optional(),
    codePrefix: z.string().max(32).optional(),
    resourceKinds: z.array(resourceFilterSchema).max(6).optional(),
    pendingScrape: z.enum(['all', 'pending', 'none']).optional(),
    sortBy: z.enum(['add_time', 'release_date', 'rating', 'code']).optional(),
    sortDir: sortDirSchema.optional(),
    limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
    offset: z.number().int().min(0).optional()
  })
  .strict()

const videoEditFields = z
  .object({
    title: limitedTextSchema.nullable().optional(),
    summary: limitedTextSchema.nullable().optional(),
    release_date: z.string().max(32).nullable().optional(),
    makerOrganization: organizationAssignmentSchema.nullable().optional(),
    publisherOrganization: organizationAssignmentSchema.nullable().optional(),
    directorAssignment: directorAssignmentSchema.nullable().optional(),
    seriesAssignment: seriesAssignmentSchema.nullable().optional(),
    duration_seconds: z.number().int().nonnegative().nullable().optional(),
    rating: z.number().min(0).max(5).optional(),
    tags: tagNamesSchema.optional(),
    actressesFemale: tagNamesSchema.optional(),
    actressesMale: tagNamesSchema.optional(),
    cover: catalogImageRefSchema.optional(),
    links: relatedLinksSchema.optional()
  })
  .strict()

const resourceTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }).strict(),
  z.object({ kind: z.literal('existing'), videoId: idSchema }).strict()
])

const rootRelativeSchema = z
  .object({
    rootId: idSchema,
    relativePath: z.string().min(1).max(4096)
  })
  .strict()

const planCommitSchema = z
  .object({
    planId: uuidSchema,
    planDigest: digestSchema
  })
  .strict()

const organizationRoleSchema = z.enum(['maker', 'publisher'])
const classificationSortSchema = z.enum(['video_count', 'updated_at'])
const classificationEntitySchema = z
  .object({
    kind: z.enum(['organization', 'director', 'series']),
    id: idSchema
  })
  .strict()

const nfoPreferencesSchema = z
  .object({
    libraryIds: idListSchema,
    profileId: z.enum(NFO_EXPORT_PROFILE_IDS),
    includeCover: z.boolean(),
    includeFanart: z.boolean(),
    includeSamples: z.boolean(),
    includeActorAvatars: z.boolean()
  })
  .strict()

const pendingScanResolutionSchema = z
  .object({
    groupId: idSchema,
    assignments: z
      .array(
        z
          .object({
            resourceId: idSchema,
            target: resourceTargetSchema
          })
          .strict()
      )
      .min(1)
      .max(DIRECT_ID_BATCH_MAX),
    primaryResourceIds: z.record(z.string().max(200), idSchema).optional()
  })
  .strict()

const actressPickerQuery = z
  .object({
    search: searchTextSchema.optional(),
    limit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
    offset: z.number().int().min(0).optional()
  })
  .strict()

export const MANAGE_OPERATION_INPUTS = {
  'handshake.get': emptyInput,
  'writer.status': emptyInput,
  'writer.claim': z
    .object({
      kind: z.enum(['initialBind', 'handoff', 'deployRecover']),
      oneTimeToken: z.string().min(32).max(256),
      candidate: z
        .object({
          claimId: uuidSchema,
          secretDigest: digestSchema
        })
        .strict()
    })
    .strict(),
  'writer.claimStatus': z.object({ claimId: uuidSchema }).strict(),
  'writer.handoffBegin': emptyInput,
  'writer.recoverIssue': emptyInput,
  'uploads.create': z
    .object({
      purpose: uploadPurposeSchema,
      contentType: imageContentTypeSchema
    })
    .strict(),
  'uploads.inspect': z.object({ uploadId: uuidSchema }).strict(),
  'play.grant': z
    .object({
      libraryId: idSchema,
      videoId: idSchema,
      resourceId: idSchema,
      locatorRevision: z.string().min(1).max(128)
    })
    .strict(),
  'tasks.get': z.object({ taskId: uuidSchema }).strict(),
  'tasks.list': z
    .object({
      libraryId: idSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'tasks.cancel': z.object({ taskId: uuidSchema }).strict(),
  'operations.get': z.object({ operationId: uuidSchema }).strict(),
  'targetLists.create': z
    .object({
      kind: z.string().min(1).max(100),
      filterDigest: digestSchema
    })
    .strict(),
  'targetLists.page': z
    .object({
      targetListId: uuidSchema,
      ...pageQuerySchema.shape
    })
    .strict(),
  'migration.preview': z
    .object({
      mappings: z
        .array(
          z
            .object({
              sourceRootId: idSchema,
              targetMountSelectionId: z.string().min(1).max(200)
            })
            .strict()
        )
        .max(200)
    })
    .strict(),
  'migration.start': z.object({ migrationId: uuidSchema, digest: digestSchema }).strict(),
  'migration.status': z.object({ migrationId: uuidSchema }).strict(),
  'migration.allowEnable': z.object({ migrationId: uuidSchema, digest: digestSchema }).strict(),
  'migration.enable': z.object({ migrationId: uuidSchema, digest: digestSchema }).strict(),
  'migration.abandon': z.object({ migrationId: uuidSchema, digest: digestSchema }).strict(),
  'home.load': z
    .object({
      seed: z.string().min(1).max(200),
      recentLimit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
      discoveryLimit: z.number().int().min(1).max(PAGE_SIZE_MAX).optional(),
      libraryIds: idListSchema.optional()
    })
    .strict(),
  'home.search': videoQuerySchema.extend({ libraryIds: idListSchema.optional() }).strict(),
  'videos.list': z
    .object({
      scope: catalogScopeSchema,
      query: videoQuerySchema.optional()
    })
    .strict(),
  'videos.get': z.object({ scope: catalogScopeSchema, videoId: idSchema }).strict(),
  'videos.years': z.object({ scope: catalogScopeSchema }).strict(),
  'videos.edit': z.object({ videoId: idSchema, fields: videoEditFields }).strict(),
  'videos.clearMeta': z.object({ videoId: idSchema }).strict(),
  'videos.markScrapeSuccess': z.object({ videoId: idSchema }).strict(),
  'videos.setRating': z.object({ videoId: idSchema, rating: z.number().min(0).max(5) }).strict(),
  'videos.correctImport': z
    .object({
      videoId: idSchema,
      code: codeSchema,
      discardPendingScrape: z.boolean()
    })
    .strict(),
  'videos.setPoster': z.object({ videoId: idSchema, image: catalogImageRefSchema }).strict(),
  'videos.importSamples': z
    .object({
      videoId: idSchema,
      images: z.array(catalogImageRefSchema).min(1).max(40)
    })
    .strict(),
  'videos.deleteSample': z.object({ videoId: idSchema, assetId: idSchema }).strict(),
  'videos.addManualTag': z.object({ videoId: idSchema, name: tagNameSchema }).strict(),
  'videos.addExistingManualTag': z.object({ videoId: idSchema, tagId: idSchema }).strict(),
  'videos.removeManualTag': z.object({ videoId: idSchema, tagId: idSchema }).strict(),
  'videos.importResource': z
    .object({
      libraryId: idSchema,
      code: codeSchema,
      target: resourceTargetSchema,
      url: z.string().min(1).max(4096),
      kind: z.enum(['direct', 'web', 'magnet', 'ed2k']).optional(),
      displayName: limitedTextSchema.nullable().optional(),
      sizeBytes: z.number().nonnegative().nullable().optional()
    })
    .strict(),
  'videos.getResource': z
    .object({ libraryId: idSchema, videoId: idSchema, resourceId: idSchema })
    .strict(),
  'videos.updateResource': z
    .object({
      libraryId: idSchema,
      videoId: idSchema,
      resourceId: idSchema,
      url: z.string().min(1).max(4096),
      kind: z.enum(['direct', 'web', 'magnet', 'ed2k']).optional(),
      displayName: limitedTextSchema.nullable().optional(),
      sizeBytes: z.number().nonnegative().nullable().optional()
    })
    .strict(),
  'videos.updateLocalResourceLabel': z
    .object({
      libraryId: idSchema,
      videoId: idSchema,
      resourceId: idSchema,
      label: limitedTextSchema.nullable()
    })
    .strict(),
  'videos.setPrimaryResource': z
    .object({ libraryId: idSchema, videoId: idSchema, resourceId: idSchema })
    .strict(),
  'videos.removeResource': z
    .object({
      libraryId: idSchema,
      videoId: idSchema,
      resourceId: idSchema,
      lastResourceMode: lastResourceModeSchema.optional()
    })
    .strict(),
  'videos.previewRemoveFromLibrary': z.object({ libraryId: idSchema, videoId: idSchema }).strict(),
  'videos.removeFromLibrary': z
    .object({ libraryId: idSchema, videoId: idSchema })
    .extend(planCommitSchema.shape)
    .strict(),
  'videos.previewMoveResource': z
    .object({
      sourceLibraryId: idSchema,
      targetLibraryId: idSchema,
      resourceId: idSchema
    })
    .strict(),
  'videos.moveResource': z
    .object({
      sourceLibraryId: idSchema,
      targetLibraryId: idSchema,
      resourceId: idSchema
    })
    .extend(planCommitSchema.shape)
    .strict(),
  'videos.previewDeleteGlobal': z.object({ videoId: idSchema }).strict(),
  'videos.deleteGlobal': z.object({ videoId: idSchema }).extend(planCommitSchema.shape).strict(),
  'videos.merge': z
    .object({
      retainedVideoId: idSchema,
      sourceVideoId: idSchema
    })
    .strict(),
  'videos.splitResource': z
    .object({ libraryId: idSchema, videoId: idSchema, resourceId: idSchema })
    .strict(),
  'videos.applyScrapeCandidate': z
    .object({
      videoId: idSchema,
      fields: videoScrapeFieldsSchema,
      mode: scrapeModeSchema,
      candidate: z.unknown(),
      cover: catalogImageRefSchema.optional(),
      samples: z.array(catalogImageRefSchema).max(40).optional()
    })
    .strict(),
  'pendingVideoScrapes.count': emptyInput,
  'pendingVideoScrapes.existingIds': emptyInput,
  'pendingVideoScrapes.page': pageQuerySchema,
  'pendingVideoScrapes.get': z.object({ pendingScrapeId: idSchema }).strict(),
  'pendingVideoScrapes.list': emptyInput,
  'pendingVideoScrapes.confirm': z
    .object({
      pendingScrapeId: idSchema,
      selections: z
        .array(
          z
            .object({
              sourceId: idSchema,
              candidateId: idSchema
            })
            .strict()
        )
        .min(1)
        .max(20),
      directorSelectionId: idSchema.optional(),
      mergeRetainedVideoId: idSchema.optional()
    })
    .strict(),
  'pendingVideoScrapes.discard': z.object({ pendingScrapeId: idSchema }).strict(),
  'tags.list': emptyInput,
  'tags.listManual': emptyInput,
  'tags.labels': z.object({ ids: idListSchema }).strict(),
  'tags.filterOptions': z
    .object({
      search: searchTextSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'tags.manualOptions': z
    .object({
      search: searchTextSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'actresses.list': z
    .object({
      search: searchTextSchema.optional(),
      gender: z.enum(['female', 'male', 'all']).optional(),
      sortBy: z.string().max(40).optional(),
      sortDir: sortDirSchema.optional()
    })
    .strict(),
  'actresses.listPage': z
    .object({
      search: searchTextSchema.optional(),
      gender: z.enum(['female', 'male', 'all']).optional(),
      status: z.enum(['all', 'success', 'unscraped', 'failed']).optional(),
      avatar: z.enum(['all', 'with', 'without', 'without-face']).optional(),
      sortBy: z.string().max(40).optional(),
      sortDir: sortDirSchema.optional(),
      actressIds: idListSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'actresses.pickerPage': actressPickerQuery,
  'actresses.pickerGet': z.object({ actressId: idSchema }).strict(),
  'actresses.testTargetPage': actressPickerQuery,
  'actresses.mergeCandidates': actressPickerQuery.extend({ keepId: idSchema }).strict(),
  'actresses.galleryPage': z.object({ actressId: idSchema }).extend(pageQuerySchema.shape).strict(),
  'actresses.profile': z.object({ actressId: idSchema }).strict(),
  'actresses.metadata': z.object({ actressId: idSchema }).strict(),
  'actresses.videoPage': z.object({ actressId: idSchema }).extend(pageQuerySchema.shape).strict(),
  'actresses.get': z.object({ actressId: idSchema }).strict(),
  'actresses.avatarSourceInfo': z.object({ actressId: idSchema }).strict(),
  'actresses.edit': z
    .object({
      actressId: idSchema,
      fields: z
        .object({
          main_name: limitedTextSchema.optional(),
          name_zh: limitedTextSchema.nullable().optional(),
          name_en: limitedTextSchema.nullable().optional(),
          aliases: tagNamesSchema.optional(),
          profile_summary: limitedTextSchema.nullable().optional(),
          gender: z.enum(['female', 'male']).nullable().optional(),
          birth_date: z.string().max(32).nullable().optional(),
          debut_date: z.string().max(32).nullable().optional(),
          height_cm: z.number().int().positive().nullable().optional(),
          bust_cm: z.number().int().positive().nullable().optional(),
          waist_cm: z.number().int().positive().nullable().optional(),
          hip_cm: z.number().int().positive().nullable().optional(),
          cup_size: z.string().max(8).nullable().optional(),
          blood_type: z.string().max(8).nullable().optional(),
          zodiac: z.string().max(32).nullable().optional(),
          nationality: z.string().max(80).nullable().optional(),
          avatar: catalogImageRefSchema.optional(),
          links: relatedLinksSchema.optional()
        })
        .strict()
    })
    .strict(),
  'actresses.delete': z
    .object({
      actressId: idSchema,
      mode: z.enum(['only-unlinked', 'unlink-videos-and-delete'])
    })
    .strict(),
  'actresses.deleteBatch': z
    .object({
      ids: idListSchema.min(1),
      mode: z.enum(['only-unlinked', 'unlink-videos-and-delete'])
    })
    .strict(),
  'actresses.deletePreview': z.object({ ids: idListSchema.min(1) }).strict(),
  'actresses.clearMeta': z.object({ actressId: idSchema }).strict(),
  'actresses.importGallery': z
    .object({
      actressId: idSchema,
      images: z.array(catalogImageRefSchema).min(1).max(40)
    })
    .strict(),
  'actresses.deleteGallery': z.object({ actressId: idSchema, assetId: idSchema }).strict(),
  'actresses.setPoster': z.object({ actressId: idSchema, image: catalogImageRefSchema }).strict(),
  'actresses.merge': z
    .object({
      retainedActressId: idSchema,
      sourceActressId: idSchema,
      mainNameActressId: idSchema
    })
    .strict(),
  'actresses.markScrapeSuccess': z.object({ actressId: idSchema }).strict(),
  'actresses.applyCrop': z
    .object({
      actressId: idSchema,
      sourceAssetId: idSchema,
      sourceDigest: digestSchema,
      sourceVersion: z.string().min(1).max(128),
      image: catalogImageRefSchema
    })
    .strict(),
  'actresses.applyScrapeCandidate': z
    .object({
      actressId: idSchema,
      candidate: z.unknown(),
      avatar: catalogImageRefSchema.optional(),
      gallery: z.array(catalogImageRefSchema).max(40).optional()
    })
    .strict(),
  'actressConflicts.list': emptyInput,
  'actressConflicts.queuePage': pageQuerySchema,
  'actressConflicts.get': z.object({ pendingId: idSchema }).strict(),
  'actressConflicts.count': emptyInput,
  'actressConflicts.summary': emptyInput,
  'actressConflicts.inspectName': z.object({ name: limitedTextSchema.min(1) }).strict(),
  'actressConflicts.discard': z.object({ pendingId: idSchema }).strict(),
  'actressConflicts.validateIllegal': z.object({ pendingId: idSchema, replacements: z.unknown() }).strict(),
  'actressConflicts.resolve': z.object({ pendingId: idSchema, choices: z.unknown() }).strict(),
  'organizations.list': z
    .object({
      role: organizationRoleSchema,
      search: searchTextSchema.optional(),
      sortBy: classificationSortSchema.optional(),
      sortDir: sortDirSchema.optional()
    })
    .strict(),
  'organizations.page': z
    .object({
      role: organizationRoleSchema,
      search: searchTextSchema.optional(),
      sortBy: classificationSortSchema.optional(),
      sortDir: sortDirSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'organizations.get': z.object({ organizationId: idSchema }).strict(),
  'organizations.options': z
    .object({
      role: organizationRoleSchema,
      search: searchTextSchema.optional()
    })
    .strict(),
  'organizations.mergeOptions': z.object({ organizationId: idSchema, search: searchTextSchema.optional() }).strict(),
  'organizations.create': z
    .object({
      role: organizationRoleSchema,
      mainName: limitedTextSchema.min(1),
      aliases: tagNamesSchema.optional(),
      summary: limitedTextSchema.nullable().optional(),
      links: relatedLinksSchema.optional()
    })
    .strict(),
  'organizations.update': z
    .object({
      organizationId: idSchema,
      mainName: limitedTextSchema.min(1),
      aliases: tagNamesSchema.optional(),
      summary: limitedTextSchema.nullable().optional(),
      keepPreviousMainName: z.boolean().optional(),
      links: relatedLinksSchema.optional()
    })
    .strict(),
  'organizations.merge': z.object({ targetId: idSchema, sourceId: idSchema }).strict(),
  'organizations.roleRemovePreview': z
    .object({ organizationId: idSchema, role: organizationRoleSchema })
    .strict(),
  'organizations.roleRemove': z
    .object({ organizationId: idSchema, role: organizationRoleSchema })
    .extend(planCommitSchema.shape)
    .strict(),
  'organizations.deletePreview': z.object({ organizationId: idSchema }).strict(),
  'organizations.delete': z.object({ organizationId: idSchema }).extend(planCommitSchema.shape).strict(),
  'directors.page': pageQuerySchema,
  'directors.list': z.object({ search: searchTextSchema.optional() }).strict(),
  'directors.get': z.object({ directorId: idSchema }).strict(),
  'directors.options': z.object({ search: searchTextSchema.optional() }).strict(),
  'directors.create': z.object({ mainName: limitedTextSchema.min(1), aliases: tagNamesSchema.optional() }).strict(),
  'directors.update': z
    .object({
      directorId: idSchema,
      mainName: limitedTextSchema.min(1),
      aliases: tagNamesSchema.optional()
    })
    .strict(),
  'directors.merge': z.object({ targetId: idSchema, sourceId: idSchema }).strict(),
  'directors.deletePreview': z.object({ directorId: idSchema }).strict(),
  'directors.delete': z.object({ directorId: idSchema }).extend(planCommitSchema.shape).strict(),
  'series.list': z.object({ search: searchTextSchema.optional() }).strict(),
  'series.page': pageQuerySchema,
  'series.get': z.object({ seriesId: idSchema }).strict(),
  'series.options': z.object({ search: searchTextSchema.optional() }).strict(),
  'series.create': z
    .object({
      mainName: limitedTextSchema.min(1),
      organizationId: idSchema.nullable().optional()
    })
    .strict(),
  'series.update': z
    .object({
      seriesId: idSchema,
      mainName: limitedTextSchema.min(1),
      organizationId: idSchema.nullable().optional()
    })
    .strict(),
  'series.merge': z.object({ targetId: idSchema, sourceId: idSchema }).strict(),
  'series.deletePreview': z.object({ seriesId: idSchema }).strict(),
  'series.delete': z.object({ seriesId: idSchema }).extend(planCommitSchema.shape).strict(),
  'classificationImages.page': z.object({ entity: classificationEntitySchema }).extend(pageQuerySchema.shape).strict(),
  'classificationImages.candidates': z.object({ entity: classificationEntitySchema }).strict(),
  'classificationImages.set': z
    .object({
      entity: classificationEntitySchema,
      image: z.union([
        catalogImageRefSchema,
        z.object({ kind: z.literal('videoCover'), videoId: idSchema }).strict()
      ])
    })
    .strict(),
  'playlists.list': emptyInput,
  'playlists.listPage': pageQuerySchema,
  'playlists.get': z.object({ playlistId: idSchema }).strict(),
  'playlists.getPage': z.object({ playlistId: idSchema }).extend(pageQuerySchema.shape).strict(),
  'playlists.metadata': z.object({ playlistId: idSchema }).strict(),
  'playlists.videoPage': z.object({ playlistId: idSchema }).extend(pageQuerySchema.shape).strict(),
  'playlists.create': z
    .object({
      name: limitedTextSchema.min(1),
      description: limitedTextSchema.nullable().optional(),
      cover: catalogImageRefSchema.optional(),
      links: relatedLinksSchema.optional()
    })
    .strict(),
  'playlists.update': z
    .object({
      playlistId: idSchema,
      name: limitedTextSchema.min(1),
      description: limitedTextSchema.nullable().optional(),
      cover: catalogImageRefSchema.optional(),
      links: relatedLinksSchema.optional()
    })
    .strict(),
  'playlists.delete': z.object({ playlistId: idSchema }).strict(),
  'playlists.listForVideo': z.object({ videoId: idSchema }).strict(),
  'playlists.addVideo': z.object({ playlistId: idSchema, videoId: idSchema }).strict(),
  'playlists.removeVideo': z.object({ playlistId: idSchema, videoId: idSchema }).strict(),
  'playlists.applyImport': z
    .object({
      name: limitedTextSchema.min(1),
      videoIds: idListSchema.min(1),
      libraryId: idSchema,
      cover: catalogImageRefSchema.optional(),
      sourceUrl: z.string().url().max(2048).optional()
    })
    .strict(),
  'libraries.list': z.object({ includeArchived: z.boolean().optional() }).strict(),
  'libraries.get': z.object({ libraryId: idSchema }).strict(),
  'libraries.create': z
    .object({
      name: limitedTextSchema.min(1),
      icon: z.string().max(40).optional(),
      color: z.string().max(40).optional()
    })
    .strict(),
  'libraries.update': z
    .object({
      libraryId: idSchema,
      name: limitedTextSchema.min(1).optional(),
      icon: z.string().max(40).optional(),
      color: z.string().max(40).optional(),
      position: z.number().int().nonnegative().optional()
    })
    .strict(),
  'libraries.updateConfig': z
    .object({
      libraryId: idSchema,
      patch: z
        .object({
          autoScanEnabled: z.boolean().optional(),
          autoScanIntervalMinutes: z.number().int().positive().optional(),
          minImportDurationMinutes: z.number().int().nonnegative().optional(),
          autoMergeSameCodeResources: z.boolean().optional(),
          autoImportLocalNfo: z.boolean().optional(),
          removeResourceLessMemberships: z.boolean().optional(),
          defaultVideoScraper: z.string().max(200).nullable().optional(),
          defaultSortBy: z.enum(['add_time', 'release_date', 'rating', 'code']).optional(),
          defaultSortDir: sortDirSchema.optional(),
          includeInHomeDiscovery: z.boolean().optional()
        })
        .strict()
    })
    .strict(),
  'libraries.addRoot': z
    .object({
      libraryId: idSchema,
      root: mountSelectionSchema.extend({
        position: z.number().int().nonnegative().optional(),
        state: z.enum(['active', 'pending_removal', 'disabled']).optional()
      })
    })
    .strict(),
  'libraries.updateRoot': z
    .object({
      libraryId: idSchema,
      rootId: idSchema,
      position: z.number().int().nonnegative().optional(),
      state: z.enum(['active', 'pending_removal', 'disabled']).optional()
    })
    .strict(),
  'libraries.removeRoot': z
    .object({ libraryId: idSchema, rootId: idSchema })
    .extend(planCommitSchema.shape)
    .strict(),
  'libraries.cancelRootRemoval': z.object({ libraryId: idSchema, rootId: idSchema }).strict(),
  'libraries.archive': z.object({ libraryId: idSchema }).strict(),
  'libraries.restore': z.object({ libraryId: idSchema }).strict(),
  'libraries.deletePreview': z.object({ libraryId: idSchema }).strict(),
  'libraries.delete': z.object({ libraryId: idSchema }).extend(planCommitSchema.shape).strict(),
  'scans.run': z.object({ libraryId: idSchema }).strict(),
  'scans.cancel': z.object({ libraryId: idSchema, taskId: uuidSchema.optional() }).strict(),
  'scans.getLatest': z.object({ libraryId: idSchema }).strict(),
  'scans.auditGet': z.object({ libraryId: idSchema }).strict(),
  'scans.auditHeader': z.object({ libraryId: idSchema }).strict(),
  'scans.auditPage': z.object({ libraryId: idSchema }).extend(pageQuerySchema.shape).strict(),
  'scans.auditViewPage': z
    .object({
      libraryId: idSchema,
      tab: z.enum(['failed', 'all', 'added_updated', 'skipped', 'changes']),
      outcome: z
        .enum(['all', 'added', 'updated', 'pending', 'skipped', 'unrecognized', 'strm_failure', 'processing_failure'])
        .optional(),
      changesFilter: z.enum(['all', 'removed', 'promoted', 'deleted']).optional(),
      search: searchTextSchema.optional(),
      locale: z.string().min(1).max(100).optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'files.rename': z
    .object({
      libraryId: idSchema,
      resourceId: idSchema,
      location: rootRelativeSchema,
      newFileName: z.string().min(1).max(512)
    })
    .extend(planCommitSchema.shape)
    .strict(),
  'files.importManual': z
    .object({
      libraryId: idSchema,
      location: rootRelativeSchema,
      code: codeSchema,
      target: resourceTargetSchema
    })
    .strict(),
  'pendingAudit.presence': emptyInput,
  'pendingScan.queuePage': z
    .object({
      libraryId: idSchema.optional(),
      ...pageQuerySchema.shape
    })
    .strict(),
  'pendingScan.queueCount': z.object({ libraryId: idSchema.optional() }).strict(),
  'pendingScan.get': z.object({ groupId: idSchema }).strict(),
  'pendingScan.list': z.object({ libraryId: idSchema.optional() }).strict(),
  'pendingScan.resolve': pendingScanResolutionSchema,
  'pendingResourceIdentity.get': z.object({ identityId: idSchema }).strict(),
  'pendingResourceIdentity.list': z.object({ libraryId: idSchema.optional() }).strict(),
  'pendingResourceIdentity.resolve': z
    .object({
      identityId: idSchema,
      choice: z.enum(['filename', 'nfo', 'discard'])
    })
    .strict(),
  'nfo.getOptions': emptyInput,
  'nfo.updatePreferences': nfoPreferencesSchema,
  'nfo.plan': nfoPreferencesSchema
    .extend({ collisionPolicy: z.enum(['skip', 'replace']) })
    .strict(),
  'nfo.discardPlan': z.object({ planId: uuidSchema }).strict(),
  'nfo.start': z.object({ planId: uuidSchema, planDigest: digestSchema }).strict(),
  'nfo.terminate': z.object({ taskId: uuidSchema }).strict(),
  'nfo.state': emptyInput,
  'browser.status': emptyInput,
  'browser.setEnabled': z.object({ enabled: z.boolean() }).strict(),
  'browser.pairOpen': emptyInput,
  'browser.pairInspect': z.object({ code: z.string().min(1).max(32) }).strict(),
  'browser.pairDecide': z
    .object({
      code: z.string().min(1).max(32),
      decision: z.enum(['approve', 'deny'])
    })
    .strict(),
  'browser.deviceRemove': z.object({ deviceId: z.string().min(1).max(80) }).strict(),
  'browser.deviceRename': z
    .object({
      deviceId: z.string().min(1).max(80),
      name: limitedTextSchema.min(1)
    })
    .strict(),
  'browser.deviceReset': z.object({ deviceId: z.string().min(1).max(80) }).strict(),
  'browser.revokeSessions': emptyInput,
  'catalog.overviewStats': emptyInput,
  'agentMetadata.findReady': z
    .object({
      target: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('video'), id: idSchema }).strict(),
        z.object({ kind: z.literal('actress'), id: idSchema }).strict()
      ])
    })
    .strict(),
  'agentMetadata.apply': z
    .object({
      draftId: z.string().min(1).max(200),
      reviewToken: z.string().min(1).max(200),
      uploads: z.array(catalogImageRefSchema).max(40).optional()
    })
    .strict(),
  'agentMetadata.discard': z.object({ draftId: z.string().min(1).max(200) }).strict()
} as const satisfies Record<ManageOperationId, z.ZodType>

export type ManageOperationInput<K extends ManageOperationId> = z.infer<(typeof MANAGE_OPERATION_INPUTS)[K]>
