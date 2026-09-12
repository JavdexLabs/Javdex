import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueries, type QueryKey } from '@tanstack/react-query'

export const CATALOG_WINDOW_PAGES = 3
export interface CatalogWindow<T> {
  total: number
  getItem(index: number): T | undefined
  onVisibleRange(start: number, end: number): void
  /** Half-open absolute range, returned as compact identities. */
  readRange(start: number, end: number, signal?: AbortSignal): Promise<{ id: number }[]>
  retry(): void
  error: boolean
}
interface Page<T> { items: T[]; total: number; readRevision?: string }
const positions = new Map<string, number>()
function remember(key: string, offset: number): void {
  positions.delete(key); positions.set(key, offset)
  while (positions.size > 20) positions.delete(positions.keys().next().value!)
}

/** At most three observed pages per mounted surface. Unobserved pages are collected
 * immediately; cursor memory stores only twenty numeric anchors, never card DTOs.
 * Absolute positions are independent of retained rows and do not shrink on eviction.
 */
export function useWindowedCatalog<T extends { id: number }, P extends Page<T>>(
  queryKey: QueryKey, pageSize: number, readPage: (offset: number) => Promise<P>, enabled = true
) {
  const key = JSON.stringify(queryKey)
  const [position, setPosition] = useState(() => ({ key, offsets: [positions.get(key) ?? 0], focus: positions.get(key) ?? 0 }))
  const state = position.key === key ? position : { key, offsets: [0], focus: 0 }
  const readRef = useRef(readPage); readRef.current = readPage
  const scope = useRef({ key, generation: 0 })
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1 }
  const generation = scope.current.generation
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const totalRef = useRef({ key, total: 0, known: false })
  if (totalRef.current.key !== key) totalRef.current = { key, total: 0, known: false }
  const results = useQueries({ queries: state.offsets.map(offset => ({
    queryKey: [...queryKey, 'window-page', offset], enabled, gcTime: 0,
    staleTime: 5 * 60 * 1000,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const page = await readPage(offset)
      if (signal.aborted) throw new Error('目录读取已取消')
      return page
    }
  })) })
  const focused = results[state.offsets.indexOf(state.focus)]
  const latest = focused?.data ?? results.find(result => result.data)?.data
  if (latest) totalRef.current = { key, total: latest.total, known: true }
  const total = totalRef.current.total
  const onVisibleRange = useCallback((start: number, end: number) => {
    if (!enabled || !Number.isFinite(start) || !Number.isFinite(end)) return
    const first = Math.floor(Math.max(0, start) / pageSize) * pageSize
    const last = Math.floor(Math.max(start, end) / pageSize) * pageSize
    const wanted: number[] = []
    for (let offset = first; offset <= last && wanted.length < CATALOG_WINDOW_PAGES; offset += pageSize) {
      if (!totalRef.current.known || offset < totalRef.current.total || offset === 0) wanted.push(offset)
    }
    if (!wanted.length) wanted.push(Math.max(0, Math.floor((totalRef.current.total - 1) / pageSize) * pageSize))
    remember(key, wanted[0])
    setPosition(previous => {
      const old = previous.key === key ? previous.offsets : []
      const offsets = [...wanted, ...old.filter(offset => !wanted.includes(offset))].slice(0, CATALOG_WINDOW_PAGES)
      if (previous.key === key && previous.focus === wanted[0] && offsets.length === previous.offsets.length && offsets.every((offset, i) => offset === previous.offsets[i])) return previous
      return { key, offsets, focus: wanted[0] }
    })
  }, [enabled, key, pageSize])
  useEffect(() => {
    if (latest && state.focus >= latest.total && state.focus > 0) onVisibleRange(Math.max(0, latest.total - 1), Math.max(0, latest.total - 1))
  }, [latest, state.focus, onVisibleRange])
  const pageMap = new Map<number, P>()
  results.forEach((result, i) => { if (result.data) pageMap.set(state.offsets[i], result.data) })
  const items = [...pageMap].sort(([a], [b]) => a - b).flatMap(([, page]) => page.items)
  const getItem = (index: number): T | undefined => pageMap.get(Math.floor(index / pageSize) * pageSize)?.items[index % pageSize]
  const readRange = async (start: number, end: number, signal?: AbortSignal): Promise<{ id: number }[]> => {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end <= start || end > total) throw new Error('选择范围已变化，请重新选择')
    const rows: { id: number }[] = [], seen = new Set<number>()
    let revision: string | undefined
    let firstPage = true
    const checkActive = () => {
      if (signal?.aborted || !alive.current || scope.current.key !== key || scope.current.generation !== generation) throw new Error('选择已取消')
    }
    // Read one page at a time, outside the browsing cache; retain only identities.
    for (let offset = Math.floor(start / pageSize) * pageSize; offset < end; offset += pageSize) {
      checkActive()
      const page = await readRef.current(offset)
      checkActive()
      if (page.total !== total || (!firstPage && page.readRevision !== revision)) throw new Error('列表已变化，请重新选择范围')
      revision = page.readRevision
      firstPage = false
      for (let i = Math.max(start, offset); i < Math.min(end, offset + pageSize); i++) {
        const row = page.items[i - offset]
        if (!row || seen.has(row.id)) throw new Error('列表已变化，请重新选择范围')
        seen.add(row.id); rows.push({ id: row.id })
      }
    }
    checkActive()
    return rows
  }
  const retry = () => { for (const result of results) void result.refetch() }
  const refetchSilent = () => { for (const result of results) if (result.isStale) void result.refetch() }
  const lastOffset = Math.max(...state.offsets)
  const window: CatalogWindow<T> = { total, getItem, onVisibleRange, readRange, retry, error: results.some(result => result.isError) }
  return { items, total, window, page: latest, loading: enabled && !totalRef.current.known && !results.some(result => result.isError),
    isFetching: results.some(result => result.isFetching), error: results.find(result => result.error)?.error,
    hasMore: lastOffset + (pageMap.get(lastOffset)?.items.length ?? pageSize) < total,
    loadMore: () => onVisibleRange(lastOffset + pageSize, lastOffset + pageSize),
    retry, refetchSilent }
}
