import { useCallback, useEffect, useRef, useState } from 'react'
import { addSelectedRange, toggleSelectedId } from './rangeSelectionState'

interface RangeSelectionEvent {
  shiftKey: boolean
  preventDefault(): void
}

/** Shared card-list selection model: click toggles, Shift adds a contiguous range. */
export function useRangeSelection<T extends { id: number }>(
  items: readonly T[],
  resetKey: string
): {
  selectedIds: Set<number>
  selectedCount: number
  selectionMode: boolean
  toggleSelection: (item: T, index: number, event?: RangeSelectionEvent) => void
  clearSelection: () => void
} {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const anchorIndexRef = useRef<number | null>(null)

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    anchorIndexRef.current = null
  }, [])

  useEffect(() => {
    clearSelection()
  }, [clearSelection, resetKey])

  const toggleSelection = useCallback(
    (item: T, index: number, event?: RangeSelectionEvent): void => {
      const anchor = anchorIndexRef.current
      if (
        event?.shiftKey &&
        anchor != null &&
        anchor >= 0 &&
        anchor < items.length &&
        index >= 0 &&
        index < items.length
      ) {
        event.preventDefault()
        setSelectedIds((current) => addSelectedRange(current, items, anchor, index))
        return
      }

      setSelectedIds((current) => toggleSelectedId(current, item.id))
      anchorIndexRef.current = index
    },
    [items]
  )

  return {
    selectedIds,
    selectedCount: selectedIds.size,
    selectionMode: selectedIds.size > 0,
    toggleSelection,
    clearSelection
  }
}
