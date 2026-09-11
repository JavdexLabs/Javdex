import { catalogReadService } from '../services/catalogReadService'
import { IPC } from '@shared/ipc-channels'
import { homeDiscoveryRepo } from '../db/homeDiscoveryRepo'
import {
  getMediaLibraryDetail,
  listMediaLibraries,
} from '../db/mediaLibraryRepo'
import { mediaLibraryService } from '../services/mediaLibraryService'
import {
  mediaLibraryCommandAdapter,
  type MediaLibraryCommandAdapter
} from './mediaLibraryContractAdapter'

export interface MediaLibraryHandlerDependencies {
  list: typeof listMediaLibraries
  get: typeof getMediaLibraryDetail
  create: typeof mediaLibraryService.create
  update: typeof mediaLibraryService.update
  updateConfig: typeof mediaLibraryService.updateConfig
  addRoot: typeof mediaLibraryService.addRoot
  updateRoot: typeof mediaLibraryService.updateRoot
  removeRoot: typeof mediaLibraryService.removeRoot
  cancelRootRemoval: typeof mediaLibraryService.cancelRootRemoval
  archive: typeof mediaLibraryService.archive
  restore: typeof mediaLibraryService.restore
  previewRemoval: typeof mediaLibraryService.previewRemoval
  remove: typeof mediaLibraryService.remove
  loadHome: (input: Parameters<typeof homeDiscoveryRepo.load>[0]) => ReturnType<typeof homeDiscoveryRepo.load> | Promise<ReturnType<typeof homeDiscoveryRepo.load>>
  search: (input: Parameters<typeof homeDiscoveryRepo.search>[0]) => ReturnType<typeof homeDiscoveryRepo.search> | Promise<ReturnType<typeof homeDiscoveryRepo.search>>
  previewRootMigration: typeof mediaLibraryService.previewRootMigration
  migrateRoot: typeof mediaLibraryService.migrateRoot
}

const defaultDependencies: MediaLibraryHandlerDependencies = {
  list: listMediaLibraries,
  get: getMediaLibraryDetail,
  create: mediaLibraryService.create,
  update: mediaLibraryService.update,
  updateConfig: mediaLibraryService.updateConfig,
  addRoot: mediaLibraryService.addRoot,
  updateRoot: mediaLibraryService.updateRoot,
  removeRoot: mediaLibraryService.removeRoot,
  cancelRootRemoval: mediaLibraryService.cancelRootRemoval,
  archive: mediaLibraryService.archive,
  restore: mediaLibraryService.restore,
  previewRemoval: mediaLibraryService.previewRemoval,
  remove: mediaLibraryService.remove,
  loadHome: (input) => catalogReadService.readHome(input),
  search: (input) => catalogReadService.searchHome(input),
  previewRootMigration: (input) => mediaLibraryService.previewRootMigration(input),
  migrateRoot: (input) => mediaLibraryService.migrateRoot(input)
}

export function registerMediaLibraryHandlers(
  dependencies: MediaLibraryHandlerDependencies = defaultDependencies,
  adapter: MediaLibraryCommandAdapter = mediaLibraryCommandAdapter
): void {
  adapter.register(IPC.MEDIA_LIBRARY_LIST, (input) => dependencies.list(input))
  adapter.register(IPC.MEDIA_LIBRARY_GET, (libraryId) => dependencies.get(libraryId))
  adapter.register(IPC.MEDIA_LIBRARY_CREATE, (input) => dependencies.create(input))
  adapter.register(IPC.MEDIA_LIBRARY_UPDATE, (input) => dependencies.update(input))
  adapter.register(IPC.MEDIA_LIBRARY_CONFIG_UPDATE, (input) =>
    dependencies.updateConfig(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_ADD, (input) => dependencies.addRoot(input))
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_UPDATE, (input) => dependencies.updateRoot(input))
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_REMOVE, (input) => dependencies.removeRoot(input))
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL, (input) =>
    dependencies.cancelRootRemoval(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW, (input) =>
    dependencies.previewRootMigration(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_MIGRATE, (input) =>
    dependencies.migrateRoot(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_ARCHIVE, (input) => dependencies.archive(input))
  adapter.register(IPC.MEDIA_LIBRARY_RESTORE, (input) => dependencies.restore(input))
  adapter.register(IPC.MEDIA_LIBRARY_DELETE_PREVIEW, (input) =>
    dependencies.previewRemoval(input.libraryId)
  )
  adapter.register(IPC.MEDIA_LIBRARY_DELETE, (input) => dependencies.remove(input))
  adapter.register(IPC.HOME_LOAD, (input) => dependencies.loadHome(input))
  adapter.register(IPC.HOME_SEARCH, (input) => dependencies.search(input))
}
