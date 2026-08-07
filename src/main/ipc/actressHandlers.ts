import { IPC } from '@shared/ipc-channels'
import { actressApplicationService } from '../services/actressApplicationService'
import { registerActressHandler } from './actressContractAdapter'

export function registerActressHandlers(): void {
  registerActressHandler(IPC.ACTRESS_LIST, (...args) =>
    actressApplicationService.listLegacy(...args)
  )
  registerActressHandler(IPC.ACTRESS_LIST_PAGE, (query) =>
    actressApplicationService.listActresses(query)
  )
  registerActressHandler(IPC.ACTRESS_FACE_SCAN_MANIFEST, () =>
    actressApplicationService.listFaceScanManifest()
  )
  registerActressHandler(IPC.ACTRESS_GET, (id) =>
    actressApplicationService.getActress(id)
  )
  registerActressHandler(IPC.ACTRESS_AVATAR_SOURCE_INFO, (id) =>
    actressApplicationService.getAvatarSourceInfo(id)
  )
  registerActressHandler(IPC.ACTRESS_EDIT, (id, input) =>
    actressApplicationService.editActress(id, input)
  )
  registerActressHandler(IPC.ACTRESS_DELETE_PREVIEW, (ids) =>
    actressApplicationService.previewDelete({ ids })
  )
  registerActressHandler(IPC.ACTRESS_DELETE, (request) =>
    actressApplicationService.deleteActresses(request)
  )
  registerActressHandler(IPC.ACTRESS_DELETE_BATCH, (request) =>
    actressApplicationService.deleteActresses(request)
  )
  registerActressHandler(IPC.ACTRESS_CLEAR_META, (id) =>
    actressApplicationService.clearMetadata(id)
  )
  registerActressHandler(IPC.ACTRESS_MERGE, (input) =>
    actressApplicationService.mergeActresses(input)
  )
  registerActressHandler(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, (id) =>
    actressApplicationService.markScrapeSucceeded(id)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_LIST, () =>
    actressApplicationService.listConflicts()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_COUNT, () =>
    actressApplicationService.countConflicts()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_SUMMARY, () =>
    actressApplicationService.getConflictSummary()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_INSPECT_NAME, (input) =>
    actressApplicationService.inspectConflictName(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_DISCARD, (input) =>
    actressApplicationService.discardConflict(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL, (input) =>
    actressApplicationService.validateIllegalNames(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_RESOLVE, (input) =>
    actressApplicationService.resolveConflict(input)
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_IMPORT, (id, input) =>
    actressApplicationService.importGalleryImage(id, input)
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_DELETE, (id, assetId) =>
    actressApplicationService.deleteGalleryImage(id, assetId)
  )
  registerActressHandler(IPC.ACTRESS_POSTER_SET, (id, posterPath) =>
    actressApplicationService.setPoster(id, posterPath)
  )
}
