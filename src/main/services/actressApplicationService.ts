import { deleteUnlinkedActressRecords } from '../db/actressRepo'
import { deleteAssetOrThrow } from './assetService'
import type {
  ActressDeleteCleanupFailure,
  ActressDeleteResult
} from '@shared/actressIpcContract'

export interface ActressApplicationService {
  deleteUnlinkedActresses(input: { ids: number[] }): ActressDeleteResult
}

interface ActressApplicationServiceDependencies {
  deleteStoredAsset: (path: string) => void
}

export function createActressApplicationService(
  dependencies: ActressApplicationServiceDependencies = { deleteStoredAsset: deleteAssetOrThrow }
): ActressApplicationService {
  return {
    deleteUnlinkedActresses(input): ActressDeleteResult {
      const deleted = deleteUnlinkedActressRecords(input.ids)
      const cleanupFailures: ActressDeleteCleanupFailure[] = []

      for (const assetPath of deleted.assetPaths) {
        try {
          dependencies.deleteStoredAsset(assetPath)
        } catch (error) {
          console.error('Failed to clean deleted actress asset:', assetPath, error)
          cleanupFailures.push({
            path: assetPath,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }

      return { deletedCount: deleted.deletedCount, cleanupFailures }
    }
  }
}

export const actressApplicationService = createActressApplicationService()
