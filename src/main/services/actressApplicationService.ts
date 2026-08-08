import {
  backfillActressGalleryAssetDimensions,
  clearActressMetadataRecord,
  deleteActressRecords,
  getActressDetail,
  listActresses,
  listActressAvatarCandidates,
  listActressPage,
  markActressScrapeSucceeded,
  previewActressDelete,
  setActressPosterPath
} from '../db/actressRepo'
import {
  editActressWithAssets,
  getActressAvatarSourceInfo,
  mergeActressesWithAssets
} from './actressAssetService'
import { mediaAssetStore } from './mediaAssetStore'
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
import type { ActressAvatarSourceInfo, ActressDetail, ActressEditInput, ActressFaceScanManifestItem, ActressGalleryAsset, ActressGalleryImportInput, ActressGenderFilter, ActressListItem, ActressListPage, ActressListQuery, ActressListSortBy, ActressMergeInput } from '@shared/actressTypes'
import { actressStatusFilterOf } from '@shared/actressTypes'
import type { SortDir } from '@shared/commonTypes'
import type { ActressConflictReviewSummary, ActressNameConflictGroup, DiscardPendingActressScrapeInput, DiscardPendingActressScrapeResult, InspectActressConflictNameInput, InspectActressConflictNameResult, ResolveActressConflictInput, ResolveActressConflictResult, ValidateIllegalNameReplacementsInput, ValidateIllegalNameReplacementsResult } from '@shared/actressConflictTypes'

export interface ActressApplicationService {
  listLegacy(
    search?: string,
    gender?: ActressGenderFilter,
    sortBy?: ActressListSortBy,
    sortDir?: SortDir
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
  listFaceScanCandidates: typeof listActressAvatarCandidates
  getActress: typeof getActressDetail
  getAvatarSourceInfo: typeof getActressAvatarSourceInfo
  editActress: typeof editActressWithAssets
  previewDelete: (ids: number[]) => ActressDeleteImpact
  deleteRecords: typeof deleteActressRecords
  clearMetadata: typeof clearActressMetadataRecord
  mergeActresses: typeof mergeActressesWithAssets
  markScrapeSucceeded: typeof markActressScrapeSucceeded
  importGalleryImage: typeof importActressGalleryImage
  deleteGalleryImage: typeof deleteActressGalleryImage
  setPoster: typeof setActressPosterPath
  repairGalleryDimensions: typeof backfillActressGalleryAssetDimensions
  inspectImage: typeof mediaAssetStore.inspectImage
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
  const deleteStoredAsset = dependencies.deleteStoredAsset ?? ((path) => mediaAssetStore.delete(path))
  const readLegacyList = dependencies.listLegacy ?? listActresses
  const readListPage = dependencies.listPage ?? listActressPage
  const readFaceScanCandidates =
    dependencies.listFaceScanCandidates ?? listActressAvatarCandidates
  const readActress = dependencies.getActress ?? getActressDetail
  const readAvatarSourceInfo = dependencies.getAvatarSourceInfo ?? getActressAvatarSourceInfo
  const updateActress = dependencies.editActress ?? editActressWithAssets
  const readDeleteImpact = dependencies.previewDelete ?? previewActressDelete
  const removeActressRecords = dependencies.deleteRecords ?? deleteActressRecords
  const clearMetadataRecord = dependencies.clearMetadata ?? clearActressMetadataRecord
  const mergeActressRecords = dependencies.mergeActresses ?? mergeActressesWithAssets
  const recordScrapeSucceeded = dependencies.markScrapeSucceeded ?? markActressScrapeSucceeded
  const importGalleryAsset = dependencies.importGalleryImage ?? importActressGalleryImage
  const deleteGalleryAsset = dependencies.deleteGalleryImage ?? deleteActressGalleryImage
  const updatePoster = dependencies.setPoster ?? setActressPosterPath
  const repairGalleryAssetDimensions =
    dependencies.repairGalleryDimensions ?? backfillActressGalleryAssetDimensions
  const inspectImage = dependencies.inspectImage ?? mediaAssetStore.inspectImage
  const avatarPageSnapshots = new Map<string, ActressListPage>()

  return {
    listLegacy(search, gender, sortBy, sortDir): ActressListItem[] {
      return readLegacyList(search, gender, sortBy, sortDir)
    },
    listFaceScanManifest(): ActressFaceScanManifestItem[] {
      return readFaceScanCandidates().flatMap((candidate) => {
        const inspection = inspectImage(candidate.avatar_path)
        if (!inspection.usable || !inspection.fingerprint) return []
        return [{
          ...candidate,
          avatar_fingerprint: inspection.fingerprint
        }]
      })
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
        const unfiltered = readListPage({
          ...requested,
          avatar: 'all',
          status: 'all',
          limit: undefined,
          offset: 0
        })
        const wantsAvatar = avatar === 'with'
        const avatarFiltered = unfiltered.items.flatMap((actress) => {
          const inspection = inspectImage(actress.avatar_path)
          if (inspection.usable !== wantsAvatar) return []
          return [wantsAvatar
            ? { ...actress, avatar_fingerprint: inspection.fingerprint }
            : actress]
        })
        const statusCounts = { all: 0, success: 0, unscraped: 0, failed: 0 }
        for (const actress of avatarFiltered) {
          statusCounts.all += 1
          statusCounts[actressStatusFilterOf(actress.scraped_status)] += 1
        }
        const requestedStatus = requested.status ?? 'all'
        const items = requestedStatus === 'all'
          ? avatarFiltered
          : avatarFiltered.filter(
              (actress) => actressStatusFilterOf(actress.scraped_status) === requestedStatus
            )
        snapshot = { items, total: items.length, statusCounts }
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
      mediaAssetStore.coordinateDatabaseChange(() => {
        const obsoletePaths = clearMetadataRecord(id)
        for (const assetPath of obsoletePaths) mediaAssetStore.deleteBestEffort(assetPath)
      })
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
      repairGalleryAssetDimensions(
        undefined,
        id,
        (assetPath) => mediaAssetStore.readStoredImageDimensions(assetPath)
      )
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
