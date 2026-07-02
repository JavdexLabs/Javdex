import { IPC } from '@shared/ipc-channels'
import type { FacetItem, FacetType } from '@shared/types'
import { deleteFacetEntry, listFacet } from '../db/facetRepo'
import { listTags, listManualTags } from '../db/tagRepo'
import { registerHandler } from './shared'

export function registerFacetHandlers(): void {
  registerHandler(
    IPC.TAG_LIST,
    (): Array<{ id: number; name: string; video_count: number }> => listTags()
  )

  registerHandler(
    IPC.TAG_LIST_MANUAL,
    (): Array<{ id: number; name: string; video_count: number }> => listManualTags()
  )

  registerHandler(IPC.FACET_LIST, (_e, type: FacetType): FacetItem[] => listFacet(type))

  registerHandler(IPC.FACET_DELETE, (_e, type: FacetType, value: string): boolean => {
    deleteFacetEntry(type, value)
    return true
  })
}
