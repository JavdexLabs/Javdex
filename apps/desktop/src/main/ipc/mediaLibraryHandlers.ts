import { IPC } from '@shared/ipc-channels'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import type { MediaLibraryRootMigrationPreview, MediaLibraryRootMigrationResult, MigrateMediaLibraryRootInput } from '@shared/mediaLibraryTypes'
import {
  mediaLibraryCommandAdapter,
  type MediaLibraryCommandAdapter
} from './mediaLibraryContractAdapter'

export interface MediaLibraryHandlerDesktopPorts {
  previewRootMigration(input: {
    sourceLibraryId: number
    targetLibraryId: number
    rootId: number
  }): MediaLibraryRootMigrationPreview
  migrateRoot(input: MigrateMediaLibraryRootInput): MediaLibraryRootMigrationResult
}

export function registerMediaLibraryHandlers(
  backend: CatalogBackend,
  desktop: MediaLibraryHandlerDesktopPorts | undefined = undefined,
  adapter: MediaLibraryCommandAdapter = mediaLibraryCommandAdapter
): void {
  adapter.register(IPC.MEDIA_LIBRARY_LIST, (input) =>
    backend.libraries.list(input ?? {})
  )
  adapter.register(IPC.MEDIA_LIBRARY_GET, (libraryId) =>
    backend.libraries.get({ libraryId })
  )
  adapter.register(IPC.MEDIA_LIBRARY_MOUNT_BROWSE, (input) =>
    backend.libraries.browseMount(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_CREATE, (input) =>
    backend.libraries.create(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_UPDATE, (input) =>
    backend.libraries.update(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_CONFIG_UPDATE, (input) =>
    backend.libraries.updateConfig(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_ADD, (input) =>
    backend.libraries.addRoot(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_UPDATE, (input) =>
    backend.libraries.updateRoot(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_REMOVE, (input) =>
    backend.libraries.removeRoot(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_REMOVE_PREVIEW, (input) =>
    backend.libraries.previewRootRemoval(input)
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_REMOVE_CANCEL, (input) =>
    backend.libraries.cancelRootRemoval(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_MIGRATE_PREVIEW, (input) => {
    if (!desktop) {
      throw new Error('当前模式不能预览本地根目录迁移')
    }
    return desktop.previewRootMigration(input)
  })
  adapter.register(IPC.MEDIA_LIBRARY_ROOT_MIGRATE, (input) => {
    if (!desktop) {
      throw new Error('当前模式不能迁移本地根目录')
    }
    return desktop.migrateRoot(input)
  })
  adapter.register(IPC.MEDIA_LIBRARY_ARCHIVE, (input) =>
    backend.libraries.archive(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_RESTORE, (input) =>
    backend.libraries.restore(input, ipcMutation())
  )
  adapter.register(IPC.MEDIA_LIBRARY_DELETE_PREVIEW, (input) =>
    backend.libraries.deletePreview({ libraryId: input.libraryId })
  )
  adapter.register(IPC.MEDIA_LIBRARY_DELETE, (input) =>
    backend.libraries.delete(input, ipcMutation())
  )
  adapter.register(IPC.HOME_LOAD, (input) => backend.queries.homeLoad(input))
  adapter.register(IPC.HOME_SEARCH, (input) => backend.queries.homeSearch(input))
}
