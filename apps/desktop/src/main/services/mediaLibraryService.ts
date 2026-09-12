import { existsSync } from 'node:fs'
import type {
  CreateMediaLibraryInput,
  MediaLibraryConfig,
  MediaLibraryConfigPatch,
  MediaLibraryDeletePreview,
  MediaLibraryDetail,
  MediaLibraryPatch,
  MediaLibraryRoot,
  MediaLibraryRootPatch,
  MediaLibraryRootMigrationPreview,
  MediaLibraryRootMigrationResult,
  MigrateMediaLibraryRootInput
} from '@shared/mediaLibraryTypes'
import type {
  CancelMediaLibraryRootRemovalInput,
  RemoveMediaLibraryRootInput
} from '@shared/mediaLibraryIpcContract'
import {
  createMediaLibraryRootMigrationRepo,
  type MediaLibraryRootMigrationRepo
} from '@library/db/mediaLibraryRootMigrationRepo'
import { getDb } from '@library/db/database'
import {
  addMediaLibraryRoot,
  archiveMediaLibrary,
  createMediaLibrary,
  deleteMediaLibrary,
  deleteMediaLibraryRoot,
  MediaLibraryRepoError,
  previewMediaLibraryDeletion,
  restoreMediaLibrary,
  updateMediaLibrary,
  updateMediaLibraryConfig,
  updateMediaLibraryRoot
} from '@library/db/mediaLibraryRepo'
import {
  cancelLibraryPathRemoval,
  previewLibraryPathRemoval
} from '@library/scan/libraryPathCleanupService'
import { isScraperPluginRunnable } from '../scrapers/scraperPluginService'
import { maintenanceTaskGate } from '@library/scan/maintenanceTaskGate'

export interface MediaLibraryServiceDependencies {
  create: typeof createMediaLibrary
  update: typeof updateMediaLibrary
  updateConfig: typeof updateMediaLibraryConfig
  addRoot: typeof addMediaLibraryRoot
  updateRoot: typeof updateMediaLibraryRoot
  removeRoot: typeof deleteMediaLibraryRoot
  cancelRootRemoval: typeof cancelLibraryPathRemoval
  previewRootRemoval: typeof previewLibraryPathRemoval
  previewRootMigration: MediaLibraryRootMigrationRepo['preview']
  migrateRoot: MediaLibraryRootMigrationRepo['migrate']
  archive: typeof archiveMediaLibrary
  restore: typeof restoreMediaLibrary
  previewRemoval: typeof previewMediaLibraryDeletion
  remove: typeof deleteMediaLibrary
  isVideoScraperRunnable: (name: string) => boolean
  runResourceMaintenance: <T>(work: () => T) => T
}

const defaultDependencies: MediaLibraryServiceDependencies = {
  create: createMediaLibrary,
  update: updateMediaLibrary,
  updateConfig: updateMediaLibraryConfig,
  addRoot: addMediaLibraryRoot,
  updateRoot: updateMediaLibraryRoot,
  removeRoot: deleteMediaLibraryRoot,
  cancelRootRemoval: cancelLibraryPathRemoval,
  previewRootRemoval: previewLibraryPathRemoval,
  previewRootMigration: (input) =>
    createMediaLibraryRootMigrationRepo(getDb(), {
      isLocalAccessible: existsSync
    }).preview(input),
  migrateRoot: (input) =>
    createMediaLibraryRootMigrationRepo(getDb(), {
      isLocalAccessible: existsSync
    }).migrate(input),
  archive: archiveMediaLibrary,
  restore: restoreMediaLibrary,
  previewRemoval: previewMediaLibraryDeletion,
  remove: deleteMediaLibrary,
  isVideoScraperRunnable: (name) => isScraperPluginRunnable('video', name),
  runResourceMaintenance: (work) => maintenanceTaskGate.runSync('resource-maintenance', work)
}

function assertRunnableScraper(
  scraperName: string | null | undefined,
  dependencies: MediaLibraryServiceDependencies
): void {
  if (scraperName == null) return
  const name = scraperName.trim()
  if (!name || !dependencies.isVideoScraperRunnable(name)) {
    throw new MediaLibraryRepoError(
      'VALIDATION_FAILED',
      `影片刮削插件「${name || scraperName}」不可用`
    )
  }
}

export function createMediaLibraryService(
  dependencies: MediaLibraryServiceDependencies = defaultDependencies
): {
  create(input: CreateMediaLibraryInput): MediaLibraryDetail
  update(input: {
    libraryId: number
    expectedRevision: number
    patch: MediaLibraryPatch
  }): MediaLibraryDetail
  updateConfig(input: {
    libraryId: number
    expectedRevision: number
    patch: MediaLibraryConfigPatch
  }): MediaLibraryConfig
  addRoot(input: Parameters<typeof addMediaLibraryRoot>[0]): MediaLibraryRoot
  updateRoot(input: {
    libraryId: number
    rootId: number
    expectedRevision: number
    patch: MediaLibraryRootPatch
  }): MediaLibraryRoot
  removeRoot(input: RemoveMediaLibraryRootInput): MediaLibraryRoot
  cancelRootRemoval(input: CancelMediaLibraryRootRemovalInput): MediaLibraryRoot
  previewRootMigration(input: {
    sourceLibraryId: number
    targetLibraryId: number
    rootId: number
  }): MediaLibraryRootMigrationPreview
  migrateRoot(input: MigrateMediaLibraryRootInput): MediaLibraryRootMigrationResult
  archive(input: Parameters<typeof archiveMediaLibrary>[0]): MediaLibraryDetail
  restore(input: Parameters<typeof restoreMediaLibrary>[0]): MediaLibraryDetail
  previewRemoval(libraryId: number): MediaLibraryDeletePreview
  remove(input: Parameters<typeof deleteMediaLibrary>[0]): MediaLibraryDetail
} {
  return {
    create(input) {
      return dependencies.runResourceMaintenance(() => {
        assertRunnableScraper(input.config?.defaultVideoScraper, dependencies)
        return dependencies.create(input)
      })
    },
    update(input) {
      return dependencies.runResourceMaintenance(() => dependencies.update(input))
    },
    updateConfig(input) {
      return dependencies.runResourceMaintenance(() => {
        // An unrelated config edit deliberately tolerates a stale stored plugin name. Only an
        // explicit scraper change must resolve to a currently runnable video plugin.
        if (input.patch.defaultVideoScraper !== undefined) {
          assertRunnableScraper(input.patch.defaultVideoScraper, dependencies)
        }
        return dependencies.updateConfig(input)
      })
    },
    addRoot(input) {
      return dependencies.runResourceMaintenance(() => dependencies.addRoot(input))
    },
    updateRoot(input) {
      return dependencies.runResourceMaintenance(() => dependencies.updateRoot(input))
    },
    removeRoot(input) {
      return dependencies.runResourceMaintenance(() => {
        const preview = dependencies.previewRootRemoval({
          libraryId: input.libraryId,
          rootId: input.rootId
        })
        if (preview.impactRevision !== input.expectedImpactRevision) {
          throw new MediaLibraryRepoError(
            'REVISION_CONFLICT',
            '根目录影响范围已变化，请重新预览后重试。',
            { currentRevision: preview.libraryRevision }
          )
        }
        return dependencies.removeRoot({
          libraryId: input.libraryId,
          rootId: input.rootId,
          expectedRevision: input.expectedRevision
        })
      })
    },
    cancelRootRemoval(input) {
      return dependencies.runResourceMaintenance(() =>
        dependencies.cancelRootRemoval(input)
      )
    },
    previewRootMigration(input) {
      return dependencies.previewRootMigration(input)
    },
    migrateRoot(input) {
      return dependencies.runResourceMaintenance(() => dependencies.migrateRoot(input))
    },
    archive(input) {
      return dependencies.runResourceMaintenance(() => dependencies.archive(input))
    },
    restore(input) {
      return dependencies.runResourceMaintenance(() => dependencies.restore(input))
    },
    previewRemoval(libraryId) {
      return dependencies.previewRemoval(libraryId)
    },
    remove(input) {
      return dependencies.runResourceMaintenance(() => dependencies.remove(input))
    }
  }
}

export const mediaLibraryService = createMediaLibraryService()
