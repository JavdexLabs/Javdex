import {
  backfillActressGalleryAssetDimensions,
  clearActressMetadataRecord,
  deleteActressRecords,
  markActressScrapeSucceeded,
  previewActressDelete,
  setActressPosterPath
} from '../db/actressRepo'
import {
  editActressWithAssets,
  mergeActressesWithAssets
} from './actressAssetService'
import { mediaAssetStore } from './mediaAssetStore'
import {
  deleteActressGalleryImage,
  importActressGalleryImage
} from './actressGalleryService'
import type {
  ActressDeleteCleanupFailure,
  ActressDeleteImpact,
  ActressDeleteRequest,
  ActressDeleteResult
} from '@shared/actressIpcContract'
import type {
  ActressEditInput,
  ActressGalleryAsset,
  ActressGalleryImportInput,
  ActressMergeInput
} from '@shared/actressTypes'

export interface ActressMaintenanceService {
  editActress(id: number, input: ActressEditInput): boolean
  previewDelete(input: { ids: number[] }): ActressDeleteImpact
  deleteActresses(input: ActressDeleteRequest): ActressDeleteResult
  clearMetadata(id: number): boolean
  mergeActresses(input: ActressMergeInput): boolean
  markScrapeSucceeded(id: number): boolean
  importGalleryImage(id: number, input: ActressGalleryImportInput): Promise<ActressGalleryAsset>
  deleteGalleryImage(id: number, assetId: number): boolean
  setPoster(id: number, posterPath: string | null): boolean
}

interface ActressMaintenanceServiceDependencies {
  deleteStoredAsset: (path: string) => void
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
}

export function createActressMaintenanceService(
  dependencies: Partial<ActressMaintenanceServiceDependencies> = {}
): ActressMaintenanceService {
  const deleteStoredAsset = dependencies.deleteStoredAsset ?? ((path) => mediaAssetStore.delete(path))
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

  return {
    editActress(id, input): boolean {
      updateActress(id, input)
      return true
    },
    previewDelete(input): ActressDeleteImpact {
      return readDeleteImpact(input.ids)
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
    }
  }
}

export const actressMaintenanceService = createActressMaintenanceService()
