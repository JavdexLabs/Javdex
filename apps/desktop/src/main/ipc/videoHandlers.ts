import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import type { VideoResourceLinkCheckResult } from '@shared/videoTypes'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { videoIpcSchemas } from './ipcCommandSchemas'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>(videoIpcSchemas)

export interface VideoHandlerDesktopPorts {
  checkLinkResource(url: string): Promise<VideoResourceLinkCheckResult>
}

export function registerVideoHandlers(
  backend: CatalogBackend,
  desktop: VideoHandlerDesktopPorts | undefined = undefined,
  adapter: typeof commandAdapter = commandAdapter
): void {
  adapter.register(IPC.VIDEO_LIST, (scope, query) =>
    backend.queries.listVideos({ scope, query })
  )
  adapter.register(IPC.VIDEO_GET, (scope, id) =>
    backend.queries.getVideo({ scope, videoId: id })
  )
  adapter.register(IPC.VIDEO_UPDATE, (id, fields) =>
    backend.videos.edit({ videoId: id, fields }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_EDIT, (id, input) =>
    backend.videos.edit({ videoId: id, fields: input }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_CLEAR_META, (id) =>
    backend.videos.clearMeta({ videoId: id }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_MARK_SCRAPE_SUCCESS, (id) =>
    backend.videos.markScrapeSuccess({ videoId: id }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_CORRECT_IMPORT, (id, code, discardPendingScrape) =>
    backend.videos.correctImport(
      { videoId: id, code, discardPendingScrape: discardPendingScrape === true },
      ipcMutation()
    )
  )
  adapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    backend.videos.setRating({ videoId: id, rating }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_YEARS, (scope) =>
    backend.queries.listVideoYears({ scope })
  )
  adapter.register(IPC.VIDEO_SAMPLE_IMPORT, (id, input) =>
    backend.videos.importSamples({ videoId: id, images: [], ...input }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_SAMPLE_DELETE, (id, assetId) =>
    backend.videos.deleteSample({ videoId: id, assetId }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_POSTER_SET, (id, posterPath) =>
    backend.videos.setPoster(
      {
        videoId: id,
        image: posterPath == null ? { kind: 'clear' } : { kind: 'asset', assetId: 1 },
        posterPath
      } as never,
      ipcMutation()
    )
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD, (id, name) =>
    backend.videos.addManualTag({ videoId: id, name }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD_EXISTING, (id, tagId) =>
    backend.videos.addExistingManualTag({ videoId: id, tagId }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_REMOVE, (id, tagId) =>
    backend.videos.removeManualTag({ videoId: id, tagId }, ipcMutation())
  )
  adapter.register(IPC.VIDEO_RESOURCE_IMPORT, (input) =>
    backend.videos.importResource(input, ipcMutation())
  )
  adapter.register(IPC.VIDEO_RESOURCE_GET, (libraryId, videoId, resourceId) =>
    backend.queries.getResource({ libraryId, videoId, resourceId })
  )
  adapter.register(IPC.VIDEO_RESOURCE_CHECK, (url) => {
    if (!desktop?.checkLinkResource) {
      throw structuredError(
        'UNSUPPORTED_CAPABILITY',
        '当前模式不能探测外部影片链接。'
      )
    }
    return desktop.checkLinkResource(url)
  })
  adapter.register(
    IPC.VIDEO_RESOURCE_UPDATE,
    (libraryId, videoId, resourceId, input) =>
      backend.videos.updateResource(
        { libraryId, videoId, resourceId, ...input },
        ipcMutation()
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL,
    (libraryId, videoId, resourceId, label) =>
      backend.videos.updateLocalResourceLabel(
        { libraryId, videoId, resourceId, label },
        ipcMutation()
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_SET_PRIMARY,
    (libraryId, videoId, resourceId) =>
      backend.videos.setPrimaryResource(
        { libraryId, videoId, resourceId },
        ipcMutation()
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_REMOVE,
    (libraryId, videoId, resourceId, lastResourceMode) =>
      backend.videos.removeResource(
        { libraryId, videoId, resourceId, lastResourceMode },
        ipcMutation()
      )
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW, (libraryId, videoId) =>
    backend.videos.previewRemoveFromLibrary({ libraryId, videoId })
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY, (input) =>
    backend.videos.removeFromLibrary(input as never, ipcMutation(input.operationId))
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_MOVE_PREVIEW,
    (sourceLibraryId, targetLibraryId, resourceId) =>
      backend.videos.previewMoveResource({
        sourceLibraryId,
        targetLibraryId,
        resourceId
      })
  )
  adapter.register(IPC.VIDEO_RESOURCE_MOVE, (input) =>
    backend.videos.moveResource(input as never, ipcMutation(input.operationId))
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL_PREVIEW, (videoId) =>
    backend.videos.previewDeleteGlobal({ videoId })
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL, (input) =>
    backend.videos.deleteGlobal(input as never, ipcMutation(input.operationId))
  )
  adapter.register(IPC.VIDEO_MERGE, (input) =>
    backend.videos.merge(input, ipcMutation())
  )
  adapter.register(IPC.VIDEO_RESOURCE_SPLIT, (libraryId, videoId, resourceId) =>
    backend.videos.splitResource({ libraryId, videoId, resourceId }, ipcMutation())
  )
}
