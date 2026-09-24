import { useWindowedCatalog } from './useWindowedCatalog'
import {
  resolveFrozenTargetSlots,
  type FrozenTargetSlot
} from './resolveFrozenTargetSlots'

export function useFrozenTargetWindow<T extends { id: number }>(
  targetListId: string,
  total: number,
  pageSize: number,
  readPage: (offset: number, limit: number) => Promise<{ ids: number[] }>,
  readOne: (id: number) => Promise<T | null>
) {
  return useWindowedCatalog<
    FrozenTargetSlot<T>,
    { items: Array<FrozenTargetSlot<T>>; total: number; readRevision: string }
  >(['frozen-target-window', targetListId], pageSize, async (offset) => {
    const page = await readPage(offset, pageSize)
    return {
      items: await resolveFrozenTargetSlots(page.ids, readOne),
      total,
      readRevision: targetListId
    }
  })
}
