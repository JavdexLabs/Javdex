import { IPC } from '@shared/ipc-channels'
import type { VideoIpcContract } from '@shared/videoIpcContract'
import { videoApplicationService } from '../services/videoApplicationService'
import { createTypedIpcAdapter } from './typedIpcAdapter'

const commandAdapter = createTypedIpcAdapter<VideoIpcContract>()

export function registerVideoHandlers(): void {
  commandAdapter.register(IPC.VIDEO_LIST, (query) => videoApplicationService.list(query))
  commandAdapter.register(IPC.VIDEO_GET, (id) => videoApplicationService.get(id))
  commandAdapter.register(IPC.VIDEO_UPDATE, (id, fields) =>
    videoApplicationService.update(id, fields)
  )
  commandAdapter.register(IPC.VIDEO_EDIT, (id, input) => videoApplicationService.edit(id, input))
  commandAdapter.register(IPC.VIDEO_CLEAR_META, (id) =>
    videoApplicationService.clearMetadata(id)
  )
  commandAdapter.register(IPC.VIDEO_MARK_SCRAPE_SUCCESS, (id) =>
    videoApplicationService.markScrapeSucceeded(id)
  )
  commandAdapter.register(IPC.VIDEO_CORRECT_IMPORT, (id, code) =>
    videoApplicationService.correctImport(id, code)
  )
  commandAdapter.register(IPC.VIDEO_DELETE, (id) => videoApplicationService.delete(id))
  commandAdapter.register(IPC.VIDEO_SET_RATING, (id, rating) =>
    videoApplicationService.setRating(id, rating)
  )
  commandAdapter.register(IPC.VIDEO_SET_PRIMARY_FILE, (videoId, fileId) =>
    videoApplicationService.setPrimaryFile(videoId, fileId)
  )
  commandAdapter.register(IPC.VIDEO_DELETE_FILE, (videoId, fileId) =>
    videoApplicationService.deleteFile(videoId, fileId)
  )
  commandAdapter.register(IPC.VIDEO_YEARS, () => videoApplicationService.listYears())
  commandAdapter.register(IPC.VIDEO_SAMPLE_IMPORT, (id, input) =>
    videoApplicationService.importSample(id, input)
  )
  commandAdapter.register(IPC.VIDEO_SAMPLE_DELETE, (id, assetId) =>
    videoApplicationService.deleteSample(id, assetId)
  )
  commandAdapter.register(IPC.VIDEO_POSTER_SET, (id, posterPath) =>
    videoApplicationService.setPoster(id, posterPath)
  )
  commandAdapter.register(IPC.VIDEO_MANUAL_TAG_ADD, (id, name) =>
    videoApplicationService.addManualTag(id, name)
  )
  commandAdapter.register(IPC.VIDEO_MANUAL_TAG_REMOVE, (id, tagId) =>
    videoApplicationService.removeManualTag(id, tagId)
  )
}
