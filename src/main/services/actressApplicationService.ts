import {
  backfillActressGalleryAssetDimensions,
  clearActressMetadataRecord,
  deleteActressRecords,
  editActress,
  getActressAvatarSourceInfo,
  getActressDetail,
  listActresses,
  listActressFaceScanManifest,
  listActressPage,
  markActressScrapeSucceeded,
  mergeActresses,
  previewActressDelete,
  setActressPosterPath
} from '../db/actressRepo'
import { deleteAssetOrThrow } from './assetService'
import {
  deleteActressGalleryImage,
  importActressGalleryImage
} from './actressGalleryService'
import { actressIdentityConflictWorkflow } from './actressIdentityConflictWorkflow'
import type {
  ActressDeleteCleanupFailure,
  ActressDeleteImpact,
  ActressDeleteRequest,
  ActressDeleteResult
} from '@shared/actressIpcContract'
import type { ActressAvatarSourceInfo, ActressEditInput, ActressFaceScanManifestItem, ActressGalleryAsset, ActressGalleryImportInput, ActressGenderFilter, ActressListItem, ActressListPage, ActressListQuery, ActressListSortBy, ActressMergeInput, ListSortDir } from '@shared/actressTypes'
import type { ActressDetail } from '@shared/libraryTypes'
import type { ActressConflictReviewSummary, ActressNameConflictGroup, DiscardPendingActressScrapeInput, DiscardPendingActressScrapeResult, InspectActressConflictNameInput, InspectActressConflictNameResult, ResolveActressConflictInput, ResolveActressConflictResult, ValidateIllegalNameReplacementsInput, ValidateIllegalNameReplacementsResult } from '@shared/actressConflictTypes'

export interface ActressApplicationService {
  listLegacy(
    search?: string,
    gender?: ActressGenderFilter,
    sortBy?: ActressListSortBy,
    sortDir?: ListSortDir
  ): ActressListItem[]
  listActresses(query?: ActressListQuery): ActressListPage
  listFaceScanManifest(): ActressFaceScanManifestItem[]
  getActress(id: number): ActressDetail | null
  getAvatarSourceInfo(id: number): ActressAvatarSourceInfo | null
  editActress(id: number, input: ActressEditInput): boolean
  previewDelete(input: { ids: number[] }): ActressDeleteImpact
  deleteActresses(input: ActressDeleteRequest): ActressDeleteResult
  clearMetadata(id: number): boolean
  mergeActresses(input: ActressMergeInput): boolean
  markScrapeSucceeded(id: number): boolean
  importGalleryImage(id: number, input: ActressGalleryImportInput): Promise<ActressGalleryAsset>
  deleteGalleryImage(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
  listConflicts(): ActressNameConflictGroup[]
  countConflicts(): number
  getConflictSummary(): ActressConflictReviewSummary
  inspectConflictName(input: InspectActressConflictNameInput): InspectActressConflictNameResult
  discardConflict(input: DiscardPendingActressScrapeInput): DiscardPendingActressScrapeResult
  validateIllegalNames(
    input: ValidateIllegalNameReplacementsInput
  ): ValidateIllegalNameReplacementsResult
  resolveConflict(input: ResolveActressConflictInput): ResolveActressConflictResult
}

interface ActressApplicationServiceDependencies {
  deleteStoredAsset: (path: string) => void
  listLegacy: typeof listActresses
  listPage: (query?: ActressListQuery) => ActressListPage
  listFaceScanManifest: () => ActressFaceScanManifestItem[]
  getActress: typeof getActressDetail
  getAvatarSourceInfo: typeof getActressAvatarSourceInfo
  editActress: typeof editActress
  previewDelete: (ids: number[]) => ActressDeleteImpact
  deleteRecords: typeof deleteActressRecords
  clearMetadata: typeof clearActressMetadataRecord
  mergeActresses: typeof mergeActresses
  markScrapeSucceeded: typeof markActressScrapeSucceeded
  importGalleryImage: typeof importActressGalleryImage
  deleteGalleryImage: typeof deleteActressGalleryImage
  setPoster: typeof setActressPosterPath
  repairGalleryDimensions: typeof backfillActressGalleryAssetDimensions
}

const MAX_AVATAR_PAGE_SNAPSHOTS = 8

function avatarPageSnapshotKey(query: ActressListQuery): string {
  return JSON.stringify({
    search: query.search?.trim() ?? '',
    gender: query.gender ?? 'female',
    status: query.status ?? 'all',
    avatar: query.avatar ?? 'all',
    sortBy: query.sortBy ?? 'video_count',
    sortDir: query.sortDir ?? 'desc',
    actressIds: query.actressIds ?? null
  })
}

export function createActressApplicationService(
  dependencies: Partial<ActressApplicationServiceDependencies> = {}
): ActressApplicationService {
  const deleteStoredAsset = dependencies.deleteStoredAsset ?? deleteAssetOrThrow
  const readLegacyList = dependencies.listLegacy ?? listActresses
  const readListPage = dependencies.listPage ?? listActressPage
  const readFaceScanManifest = dependencies.listFaceScanManifest ?? listActressFaceScanManifest
  const readActress = dependencies.getActress ?? getActressDetail
  const readAvatarSourceInfo = dependencies.getAvatarSourceInfo ?? getActressAvatarSourceInfo
  const updateActress = dependencies.editActress ?? editActress
  const readDeleteImpact = dependencies.previewDelete ?? previewActressDelete
  const removeActressRecords = dependencies.deleteRecords ?? deleteActressRecords
  const clearMetadataRecord = dependencies.clearMetadata ?? clearActressMetadataRecord
  const mergeActressRecords = dependencies.mergeActresses ?? mergeActresses
  const recordScrapeSucceeded = dependencies.markScrapeSucceeded ?? markActressScrapeSucceeded
  const importGalleryAsset = dependencies.importGalleryImage ?? importActressGalleryImage
  const deleteGalleryAsset = dependencies.deleteGalleryImage ?? deleteActressGalleryImage
  const updatePoster = dependencies.setPoster ?? setActressPosterPath
  const repairGalleryAssetDimensions =
    dependencies.repairGalleryDimensions ?? backfillActressGalleryAssetDimensions
  const avatarPageSnapshots = new Map<string, ActressListPage>()

  return {
    listLegacy(search, gender, sortBy, sortDir): ActressListItem[] {
      return readLegacyList(search, gender, sortBy, sortDir)
    },
    listFaceScanManifest(): ActressFaceScanManifestItem[] {
      return readFaceScanManifest()
    },
    getActress(id): ActressDetail | null {
      return readActress(id)
    },
    getAvatarSourceInfo(id): ActressAvatarSourceInfo | null {
      return readAvatarSourceInfo(id)
    },
    editActress(id, input): boolean {
      updateActress(id, input)
      return true
    },
    previewDelete(input): ActressDeleteImpact {
      return readDeleteImpact(input.ids)
    },
    listActresses(query): ActressListPage {
      const requested = query ?? {}
      const limit = requested.limit
      const avatar = requested.avatar ?? 'all'
      if (limit == null || avatar === 'all' || avatar === 'without-face') {
        return readListPage(requested)
      }

      const safeLimit = Math.max(1, Math.min(1000, Math.trunc(limit)))
      const safeOffset = Math.max(0, Math.trunc(requested.offset ?? 0))
      const key = avatarPageSnapshotKey(requested)
      let snapshot = safeOffset === 0 ? undefined : avatarPageSnapshots.get(key)
      if (!snapshot) {
        snapshot = readListPage({ ...requested, limit: undefined, offset: 0 })
        avatarPageSnapshots.delete(key)
        avatarPageSnapshots.set(key, snapshot)
        while (avatarPageSnapshots.size > MAX_AVATAR_PAGE_SNAPSHOTS) {
          const oldestKey = avatarPageSnapshots.keys().next().value as string | undefined
          if (oldestKey == null) break
          avatarPageSnapshots.delete(oldestKey)
        }
      }

      return {
        ...snapshot,
        items: snapshot.items.slice(safeOffset, safeOffset + safeLimit)
      }
    },
    deleteActresses(input): ActressDeleteResult {
      const deleted = removeActressRecords(input.ids, input.mode)
      const cleanupFailures: ActressDeleteCleanupFailure[] = []

      for (const assetPath of deleted.assetPaths) {
        try {
          deleteStoredAsset(assetPath)
        } catch (error) {
          console.error('Failed to clean deleted actress asset:', assetPath, error)
          cleanupFailures.push({
            path: assetPath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      return {
        deletedCount: deleted.deletedCount,
        unlinkedVideoCount: deleted.unlinkedVideoCount,
        cleanupFailures
      }
    },
    clearMetadata(id): boolean {
      clearMetadataRecord(id)
      return true
    },
    mergeActresses(input): boolean {
      mergeActressRecords(input.keepId, input.mergeId, input.mainNameFrom)
      return true
    },
    markScrapeSucceeded(id): boolean {
      recordScrapeSucceeded(id)
      return true
    },
    async importGalleryImage(id, input): Promise<ActressGalleryAsset> {
      const asset = await importGalleryAsset(id, input)
      repairGalleryAssetDimensions(undefined, id)
      return asset
    },
    deleteGalleryImage(id, assetId): boolean {
      deleteGalleryAsset(id, assetId)
      return true
    },
    setPoster(id, posterPath): boolean {
      updatePoster(id, posterPath)
      return true
    },
    listConflicts(): ActressNameConflictGroup[] {
      return actressIdentityConflictWorkflow.listConflictGroups()
    },
    countConflicts(): number {
      return actressIdentityConflictWorkflow.countPendingReviewItems()
    },
    getConflictSummary(): ActressConflictReviewSummary {
      return actressIdentityConflictWorkflow.getConflictReviewSummary()
    },
    inspectConflictName(input): InspectActressConflictNameResult {
      return actressIdentityConflictWorkflow.inspectConflictName(input)
    },
    discardConflict(input): DiscardPendingActressScrapeResult {
      return actressIdentityConflictWorkflow.discardPendingScrape(input)
    },
    validateIllegalNames(input): ValidateIllegalNameReplacementsResult {
      return actressIdentityConflictWorkflow.validateIllegalNameReplacements(input)
    },
    resolveConflict(input): ResolveActressConflictResult {
      return actressIdentityConflictWorkflow.resolveConflict(input)
    }
  }
}

export const actressApplicationService = createActressApplicationService()
