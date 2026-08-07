import { IPC } from '@shared/ipc-channels'
import type {
  ActressIpcArgs,
  ActressIpcChannel,
  ActressIpcResult
} from '@shared/actressIpcContract'
import type {
  ActressDetail,
  ActressEditInput,
  ActressGalleryAsset,
  ActressGalleryImportInput,
  ActressGenderFilter,
  ActressAvatarSourceInfo,
  ActressListItem,
  ActressListSortBy,
  ActressMergeInput,
  ActressNameConflictGroup,
  ActressConflictReviewSummary,
  InspectActressConflictNameInput,
  InspectActressConflictNameResult,
  DiscardPendingActressScrapeInput,
  DiscardPendingActressScrapeResult,
  ResolveActressConflictInput,
  ResolveActressConflictResult,
  ValidateIllegalNameReplacementsInput,
  ValidateIllegalNameReplacementsResult,
  ListSortDir
} from '@shared/types'
import {
  clearActressMetadataRecord,
  editActress,
  getActressDetail,
  getActressAvatarSourceInfo,
  listActresses,
  markActressScrapeSucceeded,
  mergeActresses,
  setActressPosterPath
} from '../db/actressRepo'
import {
  deleteActressGalleryImage,
  importActressGalleryImage
} from '../services/actressGalleryService'
import { registerHandler } from './shared'
import { actressIdentityConflictWorkflow } from '../scrapers/actressScraperManager'
import { actressApplicationService } from '../services/actressApplicationService'

function registerActressHandler<Channel extends ActressIpcChannel>(
  channel: Channel,
  handler: (...args: ActressIpcArgs<Channel>) => ActressIpcResult<Channel>
): void {
  registerHandler(channel, (_event, ...args: ActressIpcArgs<Channel>) => handler(...args))
}

export function registerActressHandlers(): void {
  registerHandler(
    IPC.ACTRESS_LIST,
    (
      _e,
      search?: string,
      gender?: ActressGenderFilter,
      sortBy?: ActressListSortBy,
      sortDir?: ListSortDir
    ): ActressListItem[] => listActresses(search, gender, sortBy, sortDir)
  )

  registerActressHandler(IPC.ACTRESS_LIST_PAGE, (query) =>
    actressApplicationService.listActresses(query)
  )

  registerHandler(IPC.ACTRESS_GET, (_e, id: number): ActressDetail | null =>
    getActressDetail(id)
  )

  registerHandler(
    IPC.ACTRESS_AVATAR_SOURCE_INFO,
    (_e, id: number): ActressAvatarSourceInfo | null => getActressAvatarSourceInfo(id)
  )

  registerHandler(IPC.ACTRESS_EDIT, (_e, id: number, input: ActressEditInput): boolean => {
    editActress(id, input)
    return true
  })

  registerActressHandler(IPC.ACTRESS_DELETE, (id) =>
    actressApplicationService.deleteUnlinkedActresses({ ids: [id] })
  )

  registerActressHandler(IPC.ACTRESS_DELETE_BATCH, (ids) =>
    actressApplicationService.deleteUnlinkedActresses({ ids })
  )

  registerHandler(IPC.ACTRESS_CLEAR_META, (_e, id: number): boolean => {
    clearActressMetadataRecord(id)
    return true
  })

  registerHandler(IPC.ACTRESS_MERGE, (_e, input: ActressMergeInput): boolean => {
    mergeActresses(input.keepId, input.mergeId, input.mainNameFrom)
    return true
  })

  registerHandler(IPC.ACTRESS_MARK_SCRAPE_SUCCESS, (_e, id: number): boolean => {
    markActressScrapeSucceeded(id)
    return true
  })

  registerHandler(IPC.ACTRESS_CONFLICT_LIST, (): ActressNameConflictGroup[] =>
    actressIdentityConflictWorkflow.listConflictGroups()
  )

  registerHandler(IPC.ACTRESS_CONFLICT_COUNT, (): number =>
    actressIdentityConflictWorkflow.countPendingReviewItems()
  )

  registerHandler(IPC.ACTRESS_CONFLICT_SUMMARY, (): ActressConflictReviewSummary =>
    actressIdentityConflictWorkflow.getConflictReviewSummary()
  )

  registerHandler(
    IPC.ACTRESS_CONFLICT_INSPECT_NAME,
    (_e, input: InspectActressConflictNameInput): InspectActressConflictNameResult =>
      actressIdentityConflictWorkflow.inspectConflictName(input)
  )

  registerHandler(
    IPC.ACTRESS_CONFLICT_DISCARD,
    (_e, input: DiscardPendingActressScrapeInput): DiscardPendingActressScrapeResult =>
      actressIdentityConflictWorkflow.discardPendingScrape(input)
  )

  registerHandler(
    IPC.ACTRESS_CONFLICT_VALIDATE_ILLEGAL,
    (
      _e,
      input: ValidateIllegalNameReplacementsInput
    ): ValidateIllegalNameReplacementsResult =>
      actressIdentityConflictWorkflow.validateIllegalNameReplacements(input)
  )

  registerHandler(
    IPC.ACTRESS_CONFLICT_RESOLVE,
    (_e, input: ResolveActressConflictInput): ResolveActressConflictResult =>
      actressIdentityConflictWorkflow.resolveConflict(input)
  )

  registerHandler(
    IPC.ACTRESS_GALLERY_IMPORT,
    (_e, id: number, input: ActressGalleryImportInput): Promise<ActressGalleryAsset> =>
      importActressGalleryImage(id, input)
  )

  registerHandler(IPC.ACTRESS_GALLERY_DELETE, (_e, id: number, assetId: number): boolean => {
    deleteActressGalleryImage(id, assetId)
    return true
  })

  registerHandler(IPC.ACTRESS_POSTER_SET, (_e, id: number, posterPath: string | null): boolean => {
    setActressPosterPath(id, posterPath)
    return true
  })
}
