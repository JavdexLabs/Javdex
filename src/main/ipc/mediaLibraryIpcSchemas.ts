import { z } from 'zod'
import { IPC } from '@shared/ipc-channels'
import type { MediaLibraryIpcContract } from '@shared/mediaLibraryIpcContract'
import {
  MEDIA_LIBRARY_COLORS,
  MEDIA_LIBRARY_COVER_MODES,
  MEDIA_LIBRARY_DEFAULT_SORTS,
  MEDIA_LIBRARY_ICONS,
  MEDIA_LIBRARY_SORT_DIRECTIONS
} from '@shared/mediaLibraryTypes'
import type { IpcArgsSchemaMap } from './typedIpcAdapter'
import { videoQueryIpcSchema } from './videoQueryIpcSchema'

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const nonEmptyText = z.string().trim().min(1)
const libraryName = nonEmptyText.max(200)
const rootPath = nonEmptyText.max(4_096)
const scraperName = nonEmptyText.max(200)
const ordinaryRootState = z.enum(['active', 'disabled'])
const libraryIdArray = z
  .array(positiveSafeInteger)
  .max(500)
  .refine((values) => new Set(values).size === values.length, '媒体库 ID 不能重复')

function requirePatch<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodType {
  return schema.refine((value) => Object.keys(value).length > 0, 'patch 至少包含一个字段')
}

const mediaLibraryConfigPatch = requirePatch(
  z
    .object({
      autoScanEnabled: z.boolean().optional(),
      autoScanIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
      minImportDurationMinutes: z.number().int().min(0).max(1_440).optional(),
      autoMergeSameCodeResources: z.boolean().optional(),
      removeResourceLessMemberships: z.boolean().optional(),
      defaultVideoScraper: scraperName.nullable().optional(),
      defaultSortBy: z.enum(MEDIA_LIBRARY_DEFAULT_SORTS).optional(),
      defaultSortDir: z.enum(MEDIA_LIBRARY_SORT_DIRECTIONS).optional(),
      defaultCoverMode: z.enum(MEDIA_LIBRARY_COVER_MODES).optional(),
      includeInHomeDiscovery: z.boolean().optional()
    })
    .strict()
)

const mediaLibraryConfigPatchForCreate = z
  .object({
    autoScanEnabled: z.boolean().optional(),
    autoScanIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
    minImportDurationMinutes: z.number().int().min(0).max(1_440).optional(),
    autoMergeSameCodeResources: z.boolean().optional(),
    removeResourceLessMemberships: z.boolean().optional(),
    defaultVideoScraper: scraperName.nullable().optional(),
    defaultSortBy: z.enum(MEDIA_LIBRARY_DEFAULT_SORTS).optional(),
    defaultSortDir: z.enum(MEDIA_LIBRARY_SORT_DIRECTIONS).optional(),
    defaultCoverMode: z.enum(MEDIA_LIBRARY_COVER_MODES).optional(),
    includeInHomeDiscovery: z.boolean().optional()
  })
  .strict()

const createRoot = z
  .object({
    path: rootPath,
    position: nonNegativeSafeInteger.optional(),
    state: ordinaryRootState.optional()
  })
  .strict()

const rootPatch = requirePatch(
  z
    .object({
      path: rootPath.optional(),
      position: nonNegativeSafeInteger.optional(),
      state: ordinaryRootState.optional()
    })
    .strict()
)

const libraryPatch = requirePatch(
  z
    .object({
      name: libraryName.optional(),
      icon: z.enum(MEDIA_LIBRARY_ICONS).optional(),
      color: z.enum(MEDIA_LIBRARY_COLORS).optional(),
      position: nonNegativeSafeInteger.optional()
    })
    .strict()
)

const revisionInput = z
  .object({
    libraryId: positiveSafeInteger,
    expectedRevision: positiveSafeInteger
  })
  .strict()

const globalSearchInput = videoQueryIpcSchema
  .extend({
    libraryIds: libraryIdArray.optional()
  })
  .strict()

export const mediaLibraryIpcSchemas = {
  [IPC.MEDIA_LIBRARY_LIST]: z.tuple([
    z.object({ includeArchived: z.boolean().optional() }).strict().optional()
  ]),
  [IPC.MEDIA_LIBRARY_GET]: z.tuple([positiveSafeInteger]),
  [IPC.MEDIA_LIBRARY_CREATE]: z.tuple([
    z
      .object({
        name: libraryName,
        icon: z.enum(MEDIA_LIBRARY_ICONS).optional(),
        color: z.enum(MEDIA_LIBRARY_COLORS).optional(),
        position: nonNegativeSafeInteger.optional(),
        config: mediaLibraryConfigPatchForCreate.optional(),
        roots: z.array(createRoot).max(64).optional()
      })
      .strict()
  ]),
  [IPC.MEDIA_LIBRARY_UPDATE]: z.tuple([
    revisionInput.extend({ patch: libraryPatch }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_CONFIG_UPDATE]: z.tuple([
    revisionInput.extend({ patch: mediaLibraryConfigPatch }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_ADD]: z.tuple([
    revisionInput.extend({ root: createRoot }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_UPDATE]: z.tuple([
    revisionInput.extend({ rootId: positiveSafeInteger, patch: rootPatch }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_REMOVE]: z.tuple([
    revisionInput
      .extend({
        rootId: positiveSafeInteger,
        expectedImpactRevision: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL]: z.tuple([
    revisionInput.extend({ rootId: positiveSafeInteger }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW]: z.tuple([
    z
      .object({
        sourceLibraryId: positiveSafeInteger,
        targetLibraryId: positiveSafeInteger,
        rootId: positiveSafeInteger
      })
      .strict()
  ]),
  [IPC.MEDIA_LIBRARY_ROOT_MIGRATE]: z.tuple([
    z
      .object({
        sourceLibraryId: positiveSafeInteger,
        targetLibraryId: positiveSafeInteger,
        rootId: positiveSafeInteger,
        expectedSourceRevision: positiveSafeInteger,
        expectedTargetRevision: positiveSafeInteger,
        expectedImpactRevision: z.string().regex(/^[a-f0-9]{64}$/)
      })
      .strict()
  ]),
  [IPC.MEDIA_LIBRARY_ARCHIVE]: z.tuple([revisionInput]),
  [IPC.MEDIA_LIBRARY_RESTORE]: z.tuple([revisionInput]),
  [IPC.MEDIA_LIBRARY_DELETE_PREVIEW]: z.tuple([
    z.object({ libraryId: positiveSafeInteger }).strict()
  ]),
  [IPC.MEDIA_LIBRARY_DELETE]: z.tuple([
    revisionInput
      .extend({ expectedImpactRevision: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
  ]),
  [IPC.HOME_LOAD]: z.tuple([
    z
      .object({
        seed: nonEmptyText.max(256),
        recentLimit: z.number().int().min(1).max(60).optional(),
        discoveryLimit: z.number().int().min(1).max(60).optional(),
        libraryIds: libraryIdArray.optional()
      })
      .strict()
  ]),
  [IPC.HOME_SEARCH]: z.tuple([globalSearchInput])
} satisfies IpcArgsSchemaMap<MediaLibraryIpcContract>
