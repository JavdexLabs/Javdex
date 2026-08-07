import { IPC } from '@shared/ipc-channels'
import type { FacetItem, FacetType } from '@shared/libraryTypes'
import { deleteFacetEntry, listFacet } from '../db/facetRepo'
import { listTags, listManualTags } from '../db/tagRepo'
import { appCommandAdapter } from './appContractAdapter'

export function registerFacetHandlers(): void {
  appCommandAdapter.register(
    IPC.TAG_LIST,
    (): Array<{ id: number; name: string; video_count: number }> => listTags()
  )

  appCommandAdapter.register(
    IPC.TAG_LIST_MANUAL,
    (): Array<{ id: number; name: string; video_count: number }> => listManualTags()
  )

  appCommandAdapter.register(IPC.FACET_LIST, (type): FacetItem[] => listFacet(type))

  appCommandAdapter.register(IPC.FACET_DELETE, (type, value): boolean => {
    deleteFacetEntry(type, value)
    return true
  })
}
