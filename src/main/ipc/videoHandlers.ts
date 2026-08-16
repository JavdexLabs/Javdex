import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { videoMaintenanceService } from '../services/videoMaintenanceService'
import { videoQueryService } from '../services/videoQueryService'
import { createTypedIpcAdapter } from './typedIpcAdapter'
import { videoIpcSchemas } from './ipcCommandSchemas'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>(videoIpcSchemas)

export function registerVideoHandlers(): void {
  commandAdapter.register(IPC.VIDEO_LIST, (query) => videoQueryService.list(query))
  commandAdapter.register(IPC.VIDEO_GET, (id) => videoQueryService.get(id))
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
  commandAdapter.register(IPC.VIDEO_DELETE, (id) => videoMaintenanceService.delete(id))
  commandAdapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    videoMaintenanceService.setRating(id, rating)
  )
  commandAdapter.register(IPC.VIDEO_YEARS, () => videoQueryService.listYears())
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
  commandAdapter.register(IPC.VIDEO_RESOURCE_GET, (videoId, resourceId) =>
    videoQueryService.getResource(videoId, resourceId)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_CHECK, (url) =>
    videoMaintenanceService.checkLinkResource(url)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_UPDATE, (videoId, resourceId, input) =>
    videoMaintenanceService.updateLinkResource(videoId, resourceId, input)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_UPDATE_LOCAL_LABEL,
    (videoId, resourceId, label) =>
      videoMaintenanceService.updateLocalResourceLabel(videoId, resourceId, label)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_SET_PRIMARY, (videoId, resourceId) =>
    videoMaintenanceService.setPrimaryResource(videoId, resourceId)
  )
  commandAdapter.register(
    IPC.VIDEO_RESOURCE_REMOVE,
    (videoId, resourceId, lastResourceMode) =>
      videoMaintenanceService.removeResource(videoId, resourceId, lastResourceMode)
  )
  commandAdapter.register(IPC.VIDEO_MERGE, (input) =>
    videoMaintenanceService.mergeVideos(input)
  )
  commandAdapter.register(IPC.VIDEO_RESOURCE_SPLIT, (videoId, resourceId) =>
    videoMaintenanceService.splitResource(videoId, resourceId)
  )
}
