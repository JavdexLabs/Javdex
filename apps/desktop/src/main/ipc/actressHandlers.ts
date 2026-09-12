import { IPC } from '@shared/ipc-channels'
import { actressIdentityConflictWorkflow } from '../services/actressIdentityConflictWorkflow'
import { actressMaintenanceService } from '../services/actressMaintenanceService'
import { actressQueryService } from '../services/actressQueryService'
import { registerActressHandler } from './actressContractAdapter'

export function registerActressHandlers(): void {
  registerActressHandler(IPC.ACTRESS_PROFILE, (id) => actressQueryService.getProfile(id))
  registerActressHandler(IPC.ACTRESS_GALLERY_PAGE, (id, query) => actressQueryService.listGallery(id, query))
  registerActressHandler(IPC.ACTRESS_METADATA, (id) => actressQueryService.getMetadata(id))
  registerActressHandler(IPC.ACTRESS_VIDEO_PAGE, (id, query) => actressQueryService.listVideos(id, query))
  registerActressHandler(IPC.ACTRESS_TEST_TARGET_PAGE, (query) => actressQueryService.listTestTargets(query))
  registerActressHandler(IPC.ACTRESS_TEST_TARGET_GET, (id) => actressQueryService.getTestTarget(id))
  registerActressHandler(IPC.ACTRESS_AVATAR_CROP_TARGETS, () => actressQueryService.listAvatarCropTargets())
  registerActressHandler(IPC.ACTRESS_AVATAR_CROP_COUNT, () => actressQueryService.countAvatarCropTargets())
  registerActressHandler(IPC.ACTRESS_MERGE_CANDIDATES, (query) => actressQueryService.listMergeCandidates(query))
  registerActressHandler(IPC.ACTRESS_PICKER_GET, (id) => actressQueryService.getPicker(id))
  registerActressHandler(IPC.ACTRESS_PICKER_PAGE, (query) => actressQueryService.listPicker(query))
  registerActressHandler(IPC.ACTRESS_LIST, (...args) =>
    actressQueryService.listLegacy(...args)
  )
  registerActressHandler(IPC.ACTRESS_LIST_PAGE, (query) =>
    actressQueryService.listActresses(query)
  )
  registerActressHandler(IPC.ACTRESS_FACE_SCAN_MANIFEST, () =>
    actressQueryService.listFaceScanManifest()
  )
  registerActressHandler(IPC.ACTRESS_GET, (id) =>
    actressQueryService.getActress(id)
  )
  registerActressHandler(IPC.ACTRESS_AVATAR_SOURCE_INFO, (id) =>
    actressQueryService.getAvatarSourceInfo(id)
  )
  registerActressHandler(IPC.ACTRESS_EDIT, (id, input) =>
    actressMaintenanceService.editActress(id, input)
  )
  registerActressHandler(IPC.ACTRESS_DELETE_PREVIEW, (ids) =>
    actressMaintenanceService.previewDelete({ ids })
  )
  registerActressHandler(IPC.ACTRESS_DELETE, (request) =>
    actressMaintenanceService.deleteActresses(request)
  )
  registerActressHandler(IPC.ACTRESS_DELETE_BATCH, (request) =>
    actressMaintenanceService.deleteActresses(request)
  )
  registerActressHandler(IPC.ACTRESS_CLEAR_META, (id) =>
    actressMaintenanceService.clearMetadata(id)
  )
  registerActressHandler(IPC.ACTRESS_MERGE, (input) =>
    actressMaintenanceService.mergeActresses(input)
  )
  registerActressHandler(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, (id) =>
    actressMaintenanceService.markScrapeSucceeded(id)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_LIST, () =>
    actressIdentityConflictWorkflow.listConflictGroups()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_QUEUE_PAGE, (query) =>
    actressIdentityConflictWorkflow.pageConflictQueue(query)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_GET, (normalizedName) =>
    actressIdentityConflictWorkflow.getConflictGroup(normalizedName)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_COUNT, () =>
    actressIdentityConflictWorkflow.countPendingReviewItems()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_SUMMARY, () =>
    actressIdentityConflictWorkflow.getConflictReviewSummary()
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_INSPECT_NAME, (input) =>
    actressIdentityConflictWorkflow.inspectConflictName(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_DISCARD, (input) =>
    actressIdentityConflictWorkflow.discardPendingScrape(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL, (input) =>
    actressIdentityConflictWorkflow.validateIllegalNameReplacements(input)
  )
  registerActressHandler(IPC.ACTRESS_CONFLICT_RESOLVE, (input) =>
    actressIdentityConflictWorkflow.resolveConflict(input)
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_IMPORT, (id, input) =>
    actressMaintenanceService.importGalleryImage(id, input)
  )
  registerActressHandler(IPC.ACTRESS_GALLERY_DELETE, (id, assetId) =>
    actressMaintenanceService.deleteGalleryImage(id, assetId)
  )
  registerActressHandler(IPC.ACTRESS_POSTER_SET, (id, posterPath) =>
    actressMaintenanceService.setPoster(id, posterPath)
  )
}
