import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface ContinuousPage<T> { items: T[]; total?: number; hasMore?: boolean; offset?: number; hasExactName?: boolean }
export interface ContinuousWindow<T> {
  total: number
  getItem(index: number): T | undefined
  findIndex(predicate: (item: T) => boolean): number
  onVisibleRange(start: number, end: number): void
  retry(): void
  error: string | null
  loading: boolean
}

/** Three retained pages; requests and errors belong to one search/object session. */
export function useContinuousPage<P extends ContinuousPage<unknown>>(scope: string, size: number, read: (offset: number) => Promise<P | null>, enabled = true, initialOffset = 0) {
  type T = P['items'][number]
  const reader = useRef(read); reader.current = read
  const initial = useRef(initialOffset); initial.current = initialOffset
  const [version, setVersion] = useState(0)
  const key = scope
  const [snapshot, setSnapshot] = useState(() => ({ key, pages: new Map<number, P>(), total: 0, known: false, exact: false, hasExactName: false, errors: new Map<number, string>() }))
  const state = useMemo(() => snapshot.key === key ? snapshot : { key, pages: new Map<number, P>(), total: 0, known: false, exact: false, hasExactName: false, errors: new Map<number, string>() }, [snapshot, key])
  const [range, setRange] = useState({ key, offsets: [Math.floor(initial.current / size) * size] })
  const offsets = range.key === key ? range.offsets : [Math.floor(initial.current / size) * size]
  const snapshotRef = useRef(state); snapshotRef.current = state
  const wanted = [...offsets].sort((a, b) => a - b).join(',')
  const loadedVersion = useRef(version)
  const invalidated = useRef(new Set<number>())
  const live = useRef(true)
  const run = useRef(0)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  useEffect(() => {
    const token = ++run.current
    if (!enabled) return
    let cancelled = false
    const refresh = loadedVersion.current !== version
    if (refresh) invalidated.current = new Set(snapshotRef.current.pages.keys())
    loadedVersion.current = version
    const retained = snapshotRef.current
    const desired = wanted.split(',').map(Number)
    setSnapshot(old => ({ ...(old.key === key ? old : { key, total: 0, known: false, exact: false, hasExactName: false }), errors: new Map([...(old.key === key ? old.errors : [])].filter(([offset]) => desired.includes(offset))), pages: new Map([...(old.key === key ? old.pages : [])].filter(([offset]) => desired.includes(offset))) }))
    const stale = () => cancelled || run.current !== token || !live.current
    const load = async () => {
      for (const offset of desired) {
        if (!invalidated.current.has(offset) && retained.pages.has(offset)) continue
        if (stale()) return
        try {
          const page = await reader.current(offset)
          if (stale()) return
          invalidated.current.delete(offset)
          setSnapshot(old => {
            if (old.key !== key || run.current !== token) return old
            const pages = new Map(old.pages); pages.set(offset, page ?? { items: [], total: 0 } as unknown as P)
            const errors = new Map(old.errors); errors.delete(offset)
            const total = page?.total ?? (page ? offset + page.items.length + (page.hasMore ? size : 0) : 0)
            return { key, pages, errors, total: page?.total !== undefined || !page?.hasMore ? total : old.exact ? old.total : Math.max(old.total, total), known: true, exact: old.exact || page?.total !== undefined || !page?.hasMore, hasExactName: old.hasExactName || Boolean(page?.hasExactName) }
          })
        } catch (error) {
          if (!stale()) setSnapshot(old => old.key !== key ? old : ({ ...old, errors: new Map(old.errors).set(offset, String((error as Error).message ?? error)) }))
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [key, wanted, size, enabled, version])
  const onVisibleRange = useCallback((start: number, end: number) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    const first = Math.floor(Math.max(0, start) / size) * size
    const last = Math.floor(Math.max(start, end) / size) * size
    setRange(old => {
      const next: number[] = []
      for (let offset = first; offset <= last && next.length < 3; offset += size) next.push(offset)
      const keep = [...next, ...(old.key === key ? old.offsets : []).filter(offset => !next.includes(offset) && (!snapshotRef.current.known || offset < snapshotRef.current.total))].slice(0, 3)
      return old.key === key && old.offsets.join(',') === keep.join(',') ? old : { key, offsets: keep }
    })
  }, [key, size])
  useEffect(() => {
    if (!state.known || !state.total || wanted.split(',').every(offset => Number(offset) < state.total)) return
    onVisibleRange(state.total - 1, state.total - 1)
  }, [state.known, state.total, wanted, onVisibleRange])
  const previousTotal = useRef({ key, total: 0 })
  useEffect(() => {
    const previous = previousTotal.current
    previousTotal.current = { key, total: state.total }
    if (previous.key === key && state.known && state.total < previous.total && [...snapshotRef.current.pages.values()].some(page => page.total !== undefined)) setVersion(value => value + 1)
  }, [key, state.known, state.total])
  const reload = useCallback(() => {
    setSnapshot(old => ({ ...old, exact: false }))
    setVersion(value => value + 1)
  }, [])
  const items = useMemo(() => [...state.pages].sort(([a], [b]) => a - b).flatMap(([, page]) => page.items as T[]), [state.pages])
  const page = useMemo((): P | undefined => {
    const ordered = [...state.pages].sort(([a], [b]) => a - b)
    if (!ordered.length) return undefined
    const [firstOffset, first] = ordered[0]
    const [lastOffset, last] = ordered[ordered.length - 1]
    const loadedEnd = lastOffset + last.items.length
    return {
      ...first,
      total: state.total,
      offset: first.offset ?? firstOffset,
      hasMore: state.exact ? loadedEnd < state.total : Boolean(last.hasMore),
      hasExactName: state.hasExactName || ordered.some(([, entry]) => entry.hasExactName)
    } as P
  }, [state.pages, state.total, state.exact, state.hasExactName])
  const error = state.errors.values().next().value ?? null
  const window: ContinuousWindow<T> = { total: state.total, getItem: index => state.pages.get(Math.floor(index / size) * size)?.items[index % size] as T | undefined, findIndex: predicate => { for (const [offset, page] of state.pages) { const index = (page.items as T[]).findIndex(predicate); if (index >= 0) return offset + index } return -1 }, onVisibleRange, retry: reload, error, loading: enabled && !state.known && !error }
  return { window, items, known: state.known, total: state.total, loading: window.loading, error, reload, page }
}
