import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { validateSelectionRange } from './rangeSelectionState'

interface RangeSelectionEvent {
  shiftKey: boolean
  preventDefault(): void
}

export interface SelectionWindow<T> {
  total: number
  getItem(index: number): T | undefined
  /** Half-open absolute range. Must reject if the underlying ordering changed. */
  readRange(start: number, end: number, signal?: AbortSignal): Promise<{ id: number }[]>
}

interface SelectionOptions<T> {
  window?: SelectionWindow<T>
  onError?: (error: unknown) => void
}

/** Selection owns compact identities, independently of resident list pages. */
export function useRangeSelection<T extends { id: number }>(
  items: readonly T[],
  resetKey: string,
  options: SelectionOptions<T> = {}
): {
  selectedIds: Set<number>
  selectedItems: { id: number }[]
  selectedCount: number
  selectionMode: boolean
  selectingRange: boolean
  selectionError: string | null
  toggleSelection: (item: T, index: number, event?: RangeSelectionEvent) => void
  clearSelection: () => void
} {
  const sessionRef = useRef({ key: resetKey, generation: 0 })
  if (sessionRef.current.key !== resetKey) {
    sessionRef.current = { key: resetKey, generation: 0 }
  }
  const session = sessionRef.current
  const [selection, setSelection] = useState<{ session: typeof session; values: Map<number, { id: number }> }>(
    () => ({ session, values: new Map() })
  )
  const abortRef = useRef<AbortController | null>(null)
  const [rangeStatus, setRangeStatus] = useState<{ session: typeof session; pending: boolean; error: string | null }>({ session, pending: false, error: null })
  const anchorRef = useRef<{ session: typeof session; index: number; id: number } | null>(null)
  // Uncancelable IPC reads are serialized; obsolete queued gestures never start a read.
  const readTail = useRef<Promise<void>>(Promise.resolve())
  const clearSelection = useCallback(() => {
    const current = sessionRef.current
    current.generation += 1
    abortRef.current?.abort()
    setRangeStatus({ session: current, pending: false, error: null })
    anchorRef.current = null
    setSelection({ session: current, values: new Map() })
  }, [])
  useEffect(() => () => { session.generation += 1; abortRef.current?.abort() }, [session])

  const toggleSelection = useCallback((item: T, index: number, event?: RangeSelectionEvent): void => {
    const current = sessionRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = ++current.generation
    setRangeStatus({ session: current, pending: false, error: null })
    const valid = (): boolean => sessionRef.current === current && current.generation === generation
    const commit = (values: readonly { id: number }[], toggle: boolean): void => {
      if (!valid()) return
      const snapshots = values.map(({ id }) => ({ id }))
      setSelection((previous) => {
        const next = new Map(previous.session === current ? previous.values : [])
        for (const value of snapshots) {
          if (toggle && next.has(value.id)) next.delete(value.id)
          else next.set(value.id, value)
        }
        return { session: current, values: next }
      })
    }
    const anchor = anchorRef.current
    if (event?.shiftKey && anchor?.session === current) {
      event.preventDefault()
      setRangeStatus({ session: current, pending: true, error: null })
      const start = Math.min(anchor.index, index)
      const end = Math.max(anchor.index, index) + 1
      const firstId = anchor.index <= index ? anchor.id : item.id
      const lastId = anchor.index <= index ? item.id : anchor.id
      const window = options.window
      const read = async (): Promise<void> => {
        if (!valid()) return
        try {
          const total = window?.total ?? items.length
          if (start < 0 || end > total) throw new Error('列表已变化，请重新选择范围')
          const values = window ? await window.readRange(start, end, controller.signal) : items.slice(start, end)
          if (!valid()) return
          validateSelectionRange(values, end - start, firstId, lastId)
          commit(values, false)
        } catch (error) {
          if (valid()) {
            setRangeStatus({ session: current, pending: false, error: String((error as Error).message ?? error) })
            options.onError?.(error)
          }
        } finally {
          if (valid()) setRangeStatus(previous => ({ ...previous, pending: false }))
        }
      }
      if (window) readTail.current = readTail.current.then(read, read)
      else void read()
      return
    }
    commit([item], true)
    anchorRef.current = { session: current, index, id: item.id }
  }, [items, options])

  const selectedItems = useMemo(
    () => selection.session === session ? [...selection.values.values()] : [], [selection, session]
  )
  const selectedIds = useMemo(() => new Set(selectedItems.map((item) => item.id)), [selectedItems])
  return { selectedIds, selectedItems, selectedCount: selectedIds.size,
    selectionMode: selectedIds.size > 0,
    selectingRange: rangeStatus.session === session && rangeStatus.pending,
    selectionError: rangeStatus.session === session ? rangeStatus.error : null,
    toggleSelection, clearSelection }
}
