import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { videoMaintenanceService } from '../services/videoMaintenanceService'
import { videoQueryService } from '../services/videoQueryService'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { videoIpcSchemas } from './ipcCommandSchemas'
import { videoLifecycleService } from '../services/videoLifecycleService'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>(videoIpcSchemas)

export function registerVideoHandlers(
  queries: typeof videoQueryService = videoQueryService,
  adapter: typeof commandAdapter = commandAdapter
): void {
  adapter.register(IPC.VIDEO_LIST, (scope, query) =>
    queries.list(scope, query)
  )
  adapter.register(IPC.VIDEO_GET, (scope, id) => queries.get(scope, id))
  adapter.register(IPC.VIDEO_UPDATE, (id, fields) =>
    videoMaintenanceService.update(id, fields)
  )
  adapter.register(IPC.VIDEO_EDIT, (id, input) => videoMaintenanceService.edit(id, input))
  adapter.register(IPC.VIDEO_CLEAR_META, (id) =>
    videoMaintenanceService.clearMetadata(id)
  )
  adapter.register(IPC.VIDEO_MARK_SCRAPE_SUCCESS, (id) =>
    videoMaintenanceService.markScrapeSucceeded(id)
  )
  adapter.register(IPC.VIDEO_CORRECT_IMPORT, (id, code, discardPendingScrape) =>
    videoMaintenanceService.correctImport(id, code, discardPendingScrape)
  )
  adapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    videoMaintenanceService.setRating(id, rating)
  )
  adapter.register(IPC.VIDEO_YEARS, (scope) => queries.listYears(scope))
  adapter.register(IPC.VIDEO_SAMPLE_IMPORT, (id, input) =>
    videoMaintenanceService.importSample(id, input)
  )
  adapter.register(IPC.VIDEO_SAMPLE_DELETE, (id, assetId) =>
    videoMaintenanceService.deleteSample(id, assetId)
  )
  adapter.register(IPC.VIDEO_POSTER_SET, (id, posterPath) =>
    videoMaintenanceService.setPoster(id, posterPath)
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD, (id, name) =>
    videoMaintenanceService.addManualTag(id, name)
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_ADD_EXISTING, (id, tagId) =>
    videoMaintenanceService.addExistingManualTag(id, tagId)
  )
  adapter.register(IPC.VIDEO_MANUAL_TAG_REMOVE, (id, tagId) =>
    videoMaintenanceService.removeManualTag(id, tagId)
  )
  adapter.register(IPC.VIDEO_RESOURCE_IMPORT, (input) =>
    videoMaintenanceService.importLinkResource(input)
  )
  adapter.register(IPC.VIDEO_RESOURCE_GET, (libraryId, videoId, resourceId) =>
    queries.getResource(libraryId, videoId, resourceId)
  )
  adapter.register(IPC.VIDEO_RESOURCE_CHECK, (url) =>
    videoMaintenanceService.checkLinkResource(url)
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_UPDATE,
    (libraryId, videoId, resourceId, input) =>
      videoMaintenanceService.updateLinkResource(libraryId, videoId, resourceId, input)
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL,
    (libraryId, videoId, resourceId, label) =>
      videoMaintenanceService.updateLocalResourceLabel(
        libraryId,
        videoId,
        resourceId,
        label
      )
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_SET_PRIMARY,
    (libraryId, videoId, resourceId) =>
      videoMaintenanceService.setPrimaryResource(libraryId, videoId, resourceId)
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_REMOVE,
    (libraryId, videoId, resourceId, lastResourceMode) =>
      videoMaintenanceService.removeResource(
        libraryId,
        videoId,
        resourceId,
        lastResourceMode
      )
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW, (libraryId, videoId) =>
    videoLifecycleService.previewRemoveFromLibrary(libraryId, videoId)
  )
  adapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY, (input) =>
    videoLifecycleService.removeFromLibrary(input)
  )
  adapter.register(
    IPC.VIDEO_RESOURCE_MOVE_PREVIEW,
    (sourceLibraryId, targetLibraryId, resourceId) =>
      videoLifecycleService.previewMoveResource(sourceLibraryId, targetLibraryId, resourceId)
  )
  adapter.register(IPC.VIDEO_RESOURCE_MOVE, (input) =>
    videoLifecycleService.moveResource(input)
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL_PREVIEW, (videoId) =>
    videoLifecycleService.previewDeleteGlobally(videoId)
  )
  adapter.register(IPC.VIDEO_DELETE_GLOBAL, (input) =>
    videoLifecycleService.deleteGlobally(input)
  )
  adapter.register(IPC.VIDEO_MERGE, (input) =>
    videoMaintenanceService.mergeVideos(input)
  )
  adapter.register(IPC.VIDEO_RESOURCE_SPLIT, (libraryId, videoId, resourceId) =>
    videoMaintenanceService.splitResource(libraryId, videoId, resourceId)
  )
}
