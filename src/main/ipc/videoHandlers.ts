import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { videoMaintenanceService } from '../services/videoMaintenanceService'
import { videoQueryService } from '../services/videoQueryService'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { videoIpcSchemas } from './ipcCommandSchemas'
import { videoLifecycleService } from '../services/videoLifecycleService'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>(videoIpcSchemas)

export function registerVideoHandlers(): void {
  commandAdapter.register(IPC.VIDEO_LIST, (scope, query) =>
    videoQueryService.list(scope, query)
  )
  commandAdapter.register(IPC.VIDEO_GET, (scope, id) => videoQueryService.get(scope, id))
  commandAdapter.register(IPC.VIDEO_UPDATE, (id, fields) =>
    videoMaintenanceService.update(id, fields)
  )
  commandAdapter.register(IPC.VIDEO_EDIT, (id, input) => videoMaintenanceService.edit(id, input))
  commandAdapter.register(IPC.VIDEO_CLEAR_META, (id) =>
    videoMaintenanceService.clearMetadata(id)
  )
  commandAdapter.register(IPC.VIDEO_MARK_SCRAPE_SUCCESS, (id) =>
    videoMaintenanceService.markScrapeSucceeded(id)
  )
  commandAdapter.register(IPC.VIDEO_CORRECT_IMPORT, (id, code, discardPendingScrape) =>
    videoMaintenanceService.correctImport(id, code, discardPendingScrape)
  )
  commandAdapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    videoMaintenanceService.setRating(id, rating)
  )
  commandAdapter.register(IPC.VIDEO_YEARS, (scope) => videoQueryService.listYears(scope))
  commandAdapter.register(IPC.VIDEO_SAMPLE_IMPORT, (id, input) =>
    videoMaintenanceService.importSample(id, input)
  )
  commandAdapter.register(IPC.VIDEO_SAMPLE_DELETE, (id, assetId) =>
    videoMaintenanceService.deleteSample(id, assetId)
  )
  commandAdapter.register(IPC.VIDEO_POSTER_SET, (id, posterPath) =>
    videoMaintenanceService.setPoster(id, posterPath)
  )
  commandAdapter.register(IPC.VIDEO_MANUAL_TAG_ADD, (id, name) =>
    videoMaintenanceService.addManualTag(id, name)
  )
  commandAdapter.register(IPC.VIDEO_MANUAL_TAG_REMOVE, (id, tagId) =>
    videoMaintenanceService.removeManualTag(id, tagId)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_IMPORT, (input) =>
    videoMaintenanceService.importLinkResource(input)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_GET, (libraryId, videoId, resourceId) =>
    videoQueryService.getResource(libraryId, videoId, resourceId)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_CHECK, (url) =>
    videoMaintenanceService.checkLinkResource(url)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_UPDATE,
    (libraryId, videoId, resourceId, input) =>
      videoMaintenanceService.updateLinkResource(libraryId, videoId, resourceId, input)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL,
    (libraryId, videoId, resourceId, label) =>
      videoMaintenanceService.updateLocalResourceLabel(
        libraryId,
        videoId,
        resourceId,
        label
      )
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_SET_PRIMARY,
    (libraryId, videoId, resourceId) =>
      videoMaintenanceService.setPrimaryResource(libraryId, videoId, resourceId)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_REMOVE,
    (libraryId, videoId, resourceId, lastResourceMode) =>
      videoMaintenanceService.removeResource(
        libraryId,
        videoId,
        resourceId,
        lastResourceMode
      )
  )
  commandAdapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY_PREVIEW, (libraryId, videoId) =>
    videoLifecycleService.previewRemoveFromLibrary(libraryId, videoId)
  )
  commandAdapter.register(IPC.VIDEO_REMOVE_FROM_LIBRARY, (input) =>
    videoLifecycleService.removeFromLibrary(input)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_MOVE_PREVIEW,
    (sourceLibraryId, targetLibraryId, resourceId) =>
      videoLifecycleService.previewMoveResource(sourceLibraryId, targetLibraryId, resourceId)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_MOVE, (input) =>
    videoLifecycleService.moveResource(input)
  )
  commandAdapter.register(IPC.VIDEO_DELETE_GLOBAL_PREVIEW, (videoId) =>
    videoLifecycleService.previewDeleteGlobally(videoId)
  )
  commandAdapter.register(IPC.VIDEO_DELETE_GLOBAL, (input) =>
    videoLifecycleService.deleteGlobally(input)
  )
  commandAdapter.register(IPC.VIDEO_MERGE, (input) =>
    videoMaintenanceService.mergeVideos(input)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_SPLIT, (libraryId, videoId, resourceId) =>
    videoMaintenanceService.splitResource(libraryId, videoId, resourceId)
  )
}
