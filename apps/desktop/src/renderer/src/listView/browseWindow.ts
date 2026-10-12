/** Paging adapters keep their own I/O, revisions and exact/estimated total semantics. */
export const BROWSE_WINDOW_PAGES = 3
export const BROWSE_ANCHOR_LIMIT = 20

export function retainBrowsePages(start: number, end: number, size: number, previous: readonly number[], total?: number): number[] {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Page size must be a positive integer')
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [...previous]
  const first = Math.floor(Math.max(0, start) / size) * size
  const last = Math.floor(Math.max(0, start, end) / size) * size
  const wanted: number[] = []
  for (let offset = first; offset <= last && wanted.length < BROWSE_WINDOW_PAGES; offset += size) {
    if (total === undefined || offset < total || offset === 0) wanted.push(offset)
  }
  if (!wanted.length) wanted.push(Math.max(0, Math.floor(((total ?? 0) - 1) / size) * size))
  return [...wanted, ...previous.filter(offset => !wanted.includes(offset) && (total === undefined || offset < total || offset === 0))].slice(0, BROWSE_WINDOW_PAGES)
}

export function createBrowseAnchorMemory<T>() {
  const entries = new Map<string, T>()
  return {
    get: (key: string): T | undefined => entries.get(key),
    remember(key: string, anchor: T): void {
      entries.delete(key)
      entries.set(key, anchor)
      while (entries.size > BROWSE_ANCHOR_LIMIT) entries.delete(entries.keys().next().value!)
    },
    clear(): void { entries.clear() }
  }
}
