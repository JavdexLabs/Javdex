import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import type { CatalogBackend } from '../application/catalogBackend'
import { ipcMutation, ipcVideoMutation } from '../application/mutationContext'
import { structuredError } from '@shared/protocol/errors'
import type { VideoResourceLinkCheckResult } from '@shared/videoTypes'
import { uploadCatalogImageSource } from '../application/remoteCatalogImage'
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
  adapter.register(IPC.VIDEO_UPDATE, async (id, fields) =>
    backend.videos.edit({ videoId: id, fields }, await ipcVideoMutation(backend, id))
  )
  adapter.register(IPC.VIDEO_EDIT, async (id, input, expectedVersions) => {
    if (backend.mode !== 'remote' || !input.coverSourcePath) {
      return backend.videos.edit({ videoId: id, fields: input }, await ipcVideoMutation(backend, id, expectedVersions))
    }
    const { coverSourcePath: _coverSourcePath, ...fields } = input
    const cover = await uploadCatalogImageSource(backend, 'videoCover', {
      source: 'file',
      sourcePath: input.coverSourcePath
    })
    return backend.videos.edit({ videoId: id, fields: { ...fields, cover } }, await ipcVideoMutation(backend, id, expectedVersions))
  })
  adapter.register(IPC.VIDEO_CLEAR_META, async (id, expectedVersions) =>
    backend.videos.clearMeta({ videoId: id }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_MARK_SCRAPE_SUCCESS, async (id, expectedVersions) =>
    backend.videos.markScrapeSuccess({ videoId: id }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_CORRECT_IMPORT, async (id, code, discardPendingScrape) =>
    backend.videos.correctImport(
      { videoId: id, code, discardPendingScrape: discardPendingScrape === true },
      await ipcVideoMutation(backend, id)
    )
  )
  adapter.register(IPC.VIDEO_SET_RATING, async (id, rating, expectedVersions) =>
    backend.videos.setRating({ videoId: id, rating }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_YEARS, (scope) =>
    backend.queries.listVideoYears({ scope })
  )
  adapter.register(IPC.VIDEO_SAMPLE_IMPORT, async (id, input) => {
    const normalized = backend.mode === 'remote'
      ? {
          videoId: id,
          images: [await uploadCatalogImageSource(backend, 'videoSample', input)]
        }
      : { videoId: id, ...input }
    const result = await backend.videos.importSamples(
      normalized as never,
      await ipcVideoMutation(backend, id)
    )
    if (backend.mode === 'local' && !('id' in result)) {
      throw structuredError('INVALID_INPUT', '本机样张导入未返回媒体资源')
    }
    return result
  })
  adapter.register(IPC.VIDEO_SAMPLE_DELETE, async (id, assetId, expectedVersions) =>
    backend.videos.deleteSample({ videoId: id, assetId }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_POSTER_SET, async (id, posterPath, assetId, expectedVersions) => {
    if (backend.mode === 'remote' && posterPath !== null && !assetId) {
      throw structuredError('INVALID_INPUT', '样张缺少媒体资源 ID，请刷新后重试')
    }
    return backend.videos.setPoster(
      {
        videoId: id,
        image: posterPath == null ? { kind: 'clear' } : { kind: 'asset', assetId: assetId! },
        ...(backend.mode === 'local' ? { posterPath } : {})
      },
      await ipcVideoMutation(backend, id, expectedVersions)
    )
  })
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD, async (id, name, expectedVersions) =>
    backend.videos.addManualTag({ videoId: id, name }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD_EXISTING, async (id, tagId, expectedVersions) =>
    backend.videos.addExistingManualTag({ videoId: id, tagId }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_REMOVE, async (id, tagId, expectedVersions) =>
    backend.videos.removeManualTag({ videoId: id, tagId }, await ipcVideoMutation(backend, id, expectedVersions))
  )
  adapter.register(IPC.VIDEO_RESOURCE_IMPORT, async (input) =>
    backend.videos.importResource(
      input,
      input.target.kind === 'existing'
        ? await ipcVideoMutation(backend, input.target.videoId)
        : ipcMutation()
    )
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
    async (libraryId, videoId, resourceId, input) =>
      backend.videos.updateResource(
        { libraryId, videoId, resourceId, ...input },
        await ipcVideoMutation(backend, videoId)
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL,
    async (libraryId, videoId, resourceId, label) =>
      backend.videos.updateLocalResourceLabel(
        { libraryId, videoId, resourceId, label },
        await ipcVideoMutation(backend, videoId)
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_SET_PRIMARY,
    async (libraryId, videoId, resourceId) =>
      backend.videos.setPrimaryResource(
        { libraryId, videoId, resourceId },
        await ipcVideoMutation(backend, videoId)
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_REMOVE,
    async (libraryId, videoId, resourceId, lastResourceMode) =>
      backend.videos.removeResource(
        { libraryId, videoId, resourceId, lastResourceMode },
        await ipcVideoMutation(backend, videoId)
      )
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW, (libraryId, videoId) =>
    backend.videos.previewRemoveFromLibrary({ libraryId, videoId })
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY, (input) =>
    backend.videos.removeFromLibrary(input, ipcMutation(input.operationId))
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
    backend.videos.moveResource(input, ipcMutation(input.operationId))
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL_PREVIEW, (videoId) =>
    backend.videos.previewDeleteGlobal({ videoId })
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL, (input) =>
    backend.videos.deleteGlobal(input, ipcMutation(input.operationId))
  )
  adapter.register(IPC.VIDEO_MERGE, async (input) =>
    backend.videos.merge(input, await ipcVideoMutation(backend, input.retainedVideoId))
  )
  adapter.register(IPC.VIDEO_RESOURCE_SPLIT, async (libraryId, videoId, resourceId) =>
    backend.videos.splitResource(
      { libraryId, videoId, resourceId },
      await ipcVideoMutation(backend, videoId)
    )
  )
}
