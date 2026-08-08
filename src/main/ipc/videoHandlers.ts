import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { videoMaintenanceService } from '../services/videoMaintenanceService'
import { videoQueryService } from '../services/videoQueryService'
import { createTypedIpcAdapter } from './typedIpcAdapter'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>()

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
  commandAdapter.register(IPC.VIDEO_CORRECT_IMPORT, (id, code) =>
    videoMaintenanceService.correctImport(id, code)
  )
  commandAdapter.register(IPC.VIDEO_DELETE, (id) => videoMaintenanceService.delete(id))
  commandAdapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    videoMaintenanceService.setRating(id, rating)
  )
  commandAdapter.register(IPC.VIDEO_SET_PRIMARY_FILE, (videoId, fileId) =>
    videoMaintenanceService.setPrimaryFile(videoId, fileId)
  )
  commandAdapter.register(IPC.VIDEO_DELETE_FILE, (videoId, fileId) =>
    videoMaintenanceService.deleteFile(videoId, fileId)
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
}
