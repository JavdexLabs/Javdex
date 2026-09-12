import { existsSync } from 'node:fs'
import type { VideoResource } from '@shared/videoTypes'
import type {
  DeleteVideoGloballyInput,
  MoveVideoResourceInput,
  RemoveVideoFromLibraryInput,
  VideoLifecycleImpact,
  VideoLifecycleResult
} from '@shared/videoLifecycleTypes'
import {
  createVideoLifecycleRepo,
  type DeleteVideoGloballyRepoResult,
  type VideoLifecycleRepo
} from '@library/db/videoLifecycleRepo'
import { listVideoResourcesAcrossLibraries } from '@library/db/videoRepo'
import { getDb } from '@library/db/database'
import {
  collectVideoLibraryCleanupHints,
  runLibraryCleanup,
  type LibraryCleanupHints
} from '@library/db/libraryCleanup'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'
import { mediaAssetStore } from '@library/mediaAssetStore'
import { videoMaintenanceService } from './videoMaintenanceService'

export interface VideoLifecycleService {
  previewRemoveFromLibrary(libraryId: number, videoId: number): VideoLifecycleImpact
  removeFromLibrary(input: RemoveVideoFromLibraryInput): VideoLifecycleResult
  previewMoveResource(
    sourceLibraryId: number,
    targetLibraryId: number,
    resourceId: number
  ): VideoLifecycleImpact
  moveResource(input: MoveVideoResourceInput): VideoLifecycleResult
  previewDeleteGlobally(videoId: number): VideoLifecycleImpact
  deleteGlobally(input: DeleteVideoGloballyInput): VideoLifecycleResult
}

interface VideoLifecycleServiceDependencies {
  repo: VideoLifecycleRepo
  isLocalAccessible: (path: string) => boolean
  withResourceMaintenance: <T>(work: () => T) => T
  runInCoordinatedChange: <T>(work: () => T) => T
  deleteOwnedAsset: (storedPath: string) => void
  cleanupVideoScrapeStagingPaths: (stagedPaths: string[]) => void
  collectVideoLibraryCleanupHints: (videoId: number) => LibraryCleanupHints
  runLibraryCleanup: (hints: LibraryCleanupHints) => void
  listSourceResources: (videoId: number) => VideoResource[]
  deleteManagedSourceFiles: <T>(resources: readonly VideoResource[], work: () => T) => T
}

function publicDeleteResult(result: DeleteVideoGloballyRepoResult): VideoLifecycleResult {
  const {
    obsoleteAssetPaths: _obsoleteAssetPaths,
    pendingStagingPaths: _pendingStagingPaths,
    ...publicResult
  } = result
  return publicResult
}

/**
 * Process boundary for membership/resource lifecycle mutations. Read-only previews can run
 * concurrently; commits share the same maintenance gate as scanning and resource edits.
 */
export function createVideoLifecycleService(
  dependencies: Partial<VideoLifecycleServiceDependencies> = {}
): VideoLifecycleService {
  const isLocalAccessible = dependencies.isLocalAccessible ?? existsSync
  const resolveRepo = (): VideoLifecycleRepo =>
    dependencies.repo ?? createVideoLifecycleRepo(getDb(), { isLocalAccessible })
  const withResourceMaintenance =
    dependencies.withResourceMaintenance ??
    (<T>(work: () => T): T => maintenanceTaskGate.runSync('resource-maintenance', work))
  const runInCoordinatedChange =
    dependencies.runInCoordinatedChange ??
    mediaAssetStore.runInCoordinatedChange.bind(mediaAssetStore)
  const deleteOwnedAsset =
    dependencies.deleteOwnedAsset ?? mediaAssetStore.deleteBestEffort.bind(mediaAssetStore)
  const cleanupStaging =
    dependencies.cleanupVideoScrapeStagingPaths ??
    mediaAssetStore.cleanupVideoScrapeStagingPaths.bind(mediaAssetStore)
  const collectCleanupHints =
    dependencies.collectVideoLibraryCleanupHints ?? collectVideoLibraryCleanupHints
  const cleanupLibrary = dependencies.runLibraryCleanup ?? runLibraryCleanup
  const listSourceResources =
    dependencies.listSourceResources ?? listVideoResourcesAcrossLibraries
  const deleteManagedSourceFiles =
    dependencies.deleteManagedSourceFiles ??
    ((resources, work) =>
      videoMaintenanceService.runWithManagedSourceFileDeletion(resources, work))

  return {
    previewRemoveFromLibrary(libraryId: number, videoId: number): VideoLifecycleImpact {
      return resolveRepo().previewRemoveFromLibrary(libraryId, videoId)
    },

    removeFromLibrary(input: RemoveVideoFromLibraryInput): VideoLifecycleResult {
      return withResourceMaintenance(() => resolveRepo().removeFromLibrary(input))
    },

    previewMoveResource(
      sourceLibraryId: number,
      targetLibraryId: number,
      resourceId: number
    ): VideoLifecycleImpact {
      return resolveRepo().previewMoveResource(sourceLibraryId, targetLibraryId, resourceId)
    },

    moveResource(input: MoveVideoResourceInput): VideoLifecycleResult {
      return withResourceMaintenance(() => resolveRepo().moveResource(input))
    },

    previewDeleteGlobally(videoId: number): VideoLifecycleImpact {
      return resolveRepo().previewDeleteGlobally(videoId)
    },

    deleteGlobally(input: DeleteVideoGloballyInput): VideoLifecycleResult {
      return withResourceMaintenance(() => {
        const cleanupHints = collectCleanupHints(input.videoId)
        const sourceResources = listSourceResources(input.videoId)
        const result = runInCoordinatedChange(() =>
          deleteManagedSourceFiles(sourceResources, () => {
            const deleted = resolveRepo().deleteGlobally(input)
            for (const storedPath of deleted.obsoleteAssetPaths) deleteOwnedAsset(storedPath)
            cleanupStaging(deleted.pendingStagingPaths)
            return deleted
          })
        )
        try {
          cleanupLibrary(cleanupHints)
        } catch (error) {
          console.error('Post-commit video library cleanup failed:', error)
        }
        return publicDeleteResult(result)
      })
    }
  }
}

export const videoLifecycleService = createVideoLifecycleService()
