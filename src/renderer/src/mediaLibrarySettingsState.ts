import type {
  CreateMediaLibraryInput,
  MediaLibrary,
  MediaLibraryConfig,
  MediaLibraryConfigPatch,
  MediaLibraryConfigValues,
  MediaLibrarySummary,
  MediaLibraryPatch
} from '@shared/mediaLibraryTypes'
import { DEFAULT_MEDIA_LIBRARY_CONFIG } from '@shared/mediaLibraryTypes'
import type { LibraryPathRemovalPreview } from '@shared/libraryTypes'

export interface MediaLibraryIdentityDraft {
  name: string
  icon: MediaLibrary['icon']
  color: MediaLibrary['color']
  position: number
}

export interface CreateMediaLibraryDraft extends MediaLibraryIdentityDraft {
  roots: string[]
  config: MediaLibraryConfigValues
  scanAfterCreate: boolean
}

export function createMediaLibraryDraft(): CreateMediaLibraryDraft {
  return {
    name: '',
    icon: 'library',
    color: 'slate',
    position: 0,
    roots: [],
    config: { ...DEFAULT_MEDIA_LIBRARY_CONFIG },
    scanAfterCreate: false
  }
}

export function buildCreateMediaLibraryInput(
  draft: CreateMediaLibraryDraft
): CreateMediaLibraryInput {
  const name = draft.name.trim()
  if (!name) throw new Error('媒体库名称不能为空')
  const roots = [
    ...new Set(draft.roots.map((path) => path.trim()).filter(Boolean))
  ]
  const config = {
    ...draft.config,
    defaultVideoScraper: draft.config.defaultVideoScraper?.trim() || null
  }
  validateMediaLibraryConfigValues(config)
  return {
    name,
    icon: draft.icon,
    color: draft.color,
    config,
    roots: roots.map((path) => ({ path, state: 'active' }))
  }
}

export const MEDIA_LIBRARY_CONFIG_KEYS = [
  'autoScanEnabled',
  'autoScanIntervalMinutes',
  'minImportDurationMinutes',
  'autoMergeSameCodeResources',
  'removeResourceLessMemberships',
  'defaultVideoScraper',
  'defaultSortBy',
  'defaultSortDir',
  'includeInHomeDiscovery'
] as const satisfies readonly (keyof MediaLibraryConfigValues)[]

export type MediaLibraryConfigKey = (typeof MEDIA_LIBRARY_CONFIG_KEYS)[number]

export function identityDraftFromLibrary(
  library: MediaLibrary
): MediaLibraryIdentityDraft {
  return {
    name: library.name,
    icon: library.icon,
    color: library.color,
    position: library.position
  }
}

export function buildMediaLibraryIdentityPatch(
  library: MediaLibrary,
  draft: MediaLibraryIdentityDraft
): MediaLibraryPatch | null {
  const name = draft.name.trim()
  if (!name) throw new Error('媒体库名称不能为空')
  if (!Number.isSafeInteger(draft.position) || draft.position < 0) {
    throw new Error('导航排序必须是非负整数')
  }
  const patch: MediaLibraryPatch = {}
  if (name !== library.name) patch.name = name
  if (draft.icon !== library.icon) patch.icon = draft.icon
  if (draft.color !== library.color) patch.color = draft.color
  if (draft.position !== library.position) patch.position = draft.position
  return Object.keys(patch).length > 0 ? patch : null
}

export function configDraftFromLibrary(
  config: MediaLibraryConfig
): MediaLibraryConfigValues {
  const { libraryId: _libraryId, revision: _revision, ...values } = config
  return values
}

export function buildMediaLibraryConfigPatch(
  config: MediaLibraryConfig,
  draft: MediaLibraryConfigValues,
  keys: readonly MediaLibraryConfigKey[] = MEDIA_LIBRARY_CONFIG_KEYS
): MediaLibraryConfigPatch | null {
  validateMediaLibraryConfigValues(draft)
  const normalized: MediaLibraryConfigValues = {
    ...draft,
    defaultVideoScraper: draft.defaultVideoScraper?.trim() || null
  }
  const patch: MediaLibraryConfigPatch = {}
  for (const key of keys) {
    if (normalized[key] !== config[key]) {
      Object.assign(patch, { [key]: normalized[key] })
    }
  }
  return Object.keys(patch).length > 0 ? patch : null
}

function validateMediaLibraryConfigValues(draft: MediaLibraryConfigValues): void {
  if (
    !Number.isInteger(draft.autoScanIntervalMinutes) ||
    draft.autoScanIntervalMinutes < 5 ||
    draft.autoScanIntervalMinutes > 10_080
  ) {
    throw new Error('自动扫描周期必须为 5 到 10080 分钟的整数')
  }
  if (
    !Number.isInteger(draft.minImportDurationMinutes) ||
    draft.minImportDurationMinutes < 0 ||
    draft.minImportDurationMinutes > 1_440
  ) {
    throw new Error('最小时长必须为 0 到 1440 分钟的整数')
  }
}

/**
 * A full scan also acts as the commit point for deferred root cleanup. Therefore a
 * library with no active roots remains runnable while it owns queued cleanup work.
 */
export function canRunMediaLibraryScan(
  library: Pick<
    MediaLibrarySummary,
    'status' | 'activeRootCount' | 'pendingCleanupJobCount'
  >
): boolean {
  return (
    library.status === 'active' &&
    (library.activeRootCount > 0 || library.pendingCleanupJobCount > 0)
  )
}

/** Whether removing this root must first queue the scan-safe cleanup transaction. */
export function rootRemovalRequiresCleanup(
  preview: Pick<
    LibraryPathRemovalPreview,
    | 'localResourceCount'
    | 'strmResourceCount'
    | 'pendingScanResourceCount'
    | 'unrecognizedFileCount'
    | 'terminalCleanupJobCount'
  >
): boolean {
  // Terminal jobs are audit-only. They do not need a filesystem-safe cleanup pass,
  // but the direct-deletion confirmation must disclose that their history is removed.
  return (
    preview.localResourceCount > 0 ||
    preview.strmResourceCount > 0 ||
    preview.pendingScanResourceCount > 0 ||
    preview.unrecognizedFileCount > 0
  )
}

export function mediaLibraryRootAddFailureMessage(
  addedCount: number,
  errorMessage: string
): string {
  return addedCount > 0
    ? `已添加 ${addedCount} 个来源目录，其余目录添加失败：${errorMessage}`
    : errorMessage
}

export function mediaLibrarySettingsLoadState(input: {
  isLoading: boolean
  isError: boolean
  hasLibrary: boolean
  hasDrafts: boolean
}): 'loading' | 'error' | 'ready' {
  if (input.isError || (!input.isLoading && !input.hasLibrary)) return 'error'
  if (input.isLoading || !input.hasLibrary || !input.hasDrafts) return 'loading'
  return 'ready'
}

export function mediaLibraryLifecycleCapabilities(
  library: Pick<MediaLibrary, 'isDefault' | 'status'>
): { canArchive: boolean; canRestore: boolean; canDelete: boolean } {
  if (library.isDefault) {
    return { canArchive: false, canRestore: false, canDelete: false }
  }
  return library.status === 'active'
    ? { canArchive: true, canRestore: false, canDelete: false }
    : { canArchive: false, canRestore: true, canDelete: true }
}
