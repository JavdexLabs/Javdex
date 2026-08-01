import { IPC } from '@shared/ipc-channels'
import type {
  ActressDetail,
  ActressEditInput,
  ActressGalleryAsset,
  ActressGalleryImportInput,
  ActressGenderFilter,
  ActressAvatarSourceInfo,
  ActressListItem,
  ActressListPage,
  ActressListQuery,
  ActressListSortBy,
  ActressMergeInput,
  ActressNameConflictGroup,
  DiscardPendingActressScrapeInput,
  DiscardPendingActressScrapeResult,
  ListSortDir
} from '@shared/types'
import {
  deleteActress,
  deleteUnlinkedActresses,
  clearActressMetadataRecord,
  editActress,
  getActressDetail,
  getActressAvatarSourceInfo,
  listActresses,
  listActressPage,
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

  registerHandler(
    IPC.ACTRESS_LIST_PAGE,
    (_e, query?: ActressListQuery): ActressListPage => listActressPage(query)
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

  registerHandler(IPC.ACTRESS_DELETE, (_e, id: number): boolean => {
    deleteActress(id)
    return true
  })

  registerHandler(IPC.ACTRESS_DELETE_BATCH, (_e, ids: number[]): number =>
    deleteUnlinkedActresses(ids)
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
    actressIdentityConflictWorkflow.countPendingScrapes()
  )

  registerHandler(
    IPC.ACTRESS_CONFLICT_DISCARD,
    (_e, input: DiscardPendingActressScrapeInput): DiscardPendingActressScrapeResult =>
      actressIdentityConflictWorkflow.discardPendingScrape(input)
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
