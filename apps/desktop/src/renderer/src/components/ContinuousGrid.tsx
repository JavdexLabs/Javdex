import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ContinuousWindow } from '../hooks/useContinuousPage'
import Button from './Button'
import styles from './ContinuousGrid.module.css'

interface Props<T> {
  window: ContinuousWindow<T>
  renderItem(item: T, index: number): ReactNode
  itemKey(item: T): string | number
  label: string
  role?: 'group' | 'listbox'
  multiSelect?: boolean
  scope: string
  gap?: number
  minWidth?: number
  itemHeight?: number | ((width: number) => number)
  contained?: boolean
  fill?: boolean
  remember?: boolean
  scrollRef?: RefObject<HTMLElement>
  initialIndex?: number
  pageSize?: number
  emptyLabel?: string
  onAnchor?: (index: number) => void
}
const memories = new Map<string, { index: number; delta: number; key?: string | number }>()
/** Clear restoration anchors when resetting a browsing session. */
export function clearContinuousScrollMemory(): void { memories.clear() }
function scrollingParent(element: HTMLElement): HTMLElement {
  let parent = element.parentElement
  while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement
  return parent ?? document.documentElement
}

function samePage(index: number, origin: number, pageSize?: number): boolean {
  return pageSize == null || Math.floor(index / pageSize) * pageSize === Math.floor(origin / pageSize) * pageSize
}

/** Fixed geometry with one scrolling owner, including detail-page external scroll. */
export default function ContinuousGrid<T>({ window: data, renderItem, itemKey, label, role = 'group', multiSelect, scope, minWidth = 0, gap = minWidth ? 12 : 4, itemHeight = 64, contained = false, fill = false, remember = !contained, scrollRef, initialIndex = 0, pageSize, emptyLabel = '没有匹配项', onAnchor }: Props<T>): JSX.Element {
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null)
  const latest = useRef({ data, onAnchor, itemKey }); latest.current = { data, onAnchor, itemKey }
  const [geometry, setGeometry] = useState({ width: 0, top: 0, height: 400 })
  const [focus, setFocus] = useState<{ index: number; pending: boolean; key?: string | number } | null>(null)
  const columns = minWidth ? Math.max(1, Math.floor((geometry.width + gap) / (minWidth + gap))) : 1
  const width = Math.max(0, (geometry.width - (columns - 1) * gap) / columns)
  const rowHeight = (typeof itemHeight === 'function' ? itemHeight(width) : itemHeight) + gap
  const rows = Math.ceil(data.total / columns)
  const start = Math.max(0, Math.floor(geometry.top / rowHeight) - 1) * columns
  const end = Math.min(data.total, (Math.ceil((geometry.top + geometry.height) / rowHeight) + 1) * columns)
  const hasItems = data.total > 0
  const initial = useRef(initialIndex); initial.current = initialIndex
  const anchor = useRef({ index: initialIndex, delta: 0 })
  const appliedLayout = useRef({ columns, rowHeight })
  const measure = useRef<(() => void) | null>(null)
  const layout = useRef({ columns, rowHeight }); layout.current = { columns, rowHeight }
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const scroller = contained ? viewport.current! : scrollRef?.current ?? scrollingParent(element)
    setFocus(null)
    let restored = false, frame = 0
    const update = () => {
      const bounds = element.getBoundingClientRect(), outer = scroller.getBoundingClientRect()
      const localTop = scroller.scrollTop + bounds.top - outer.top
      if (!restored && latest.current.data.total && element.clientWidth > 0 && layout.current.columns === (minWidth ? Math.max(1, Math.floor((element.clientWidth + gap) / (minWidth + gap))) : 1)) {
        const memory = remember ? memories.get(scope) : undefined
        const saved = memory && samePage(memory.index, initial.current, pageSize) ? { ...memory } : { index: initial.current, delta: 0 }
        const resolved = saved.key === undefined ? -1 : latest.current.data.findIndex(item => latest.current.itemKey(item) === saved.key)
        if (resolved >= 0 && samePage(resolved, initial.current, pageSize)) saved.index = resolved
        if (!remember || saved.index || saved.delta || scroller.scrollTop > localTop) scroller.scrollTop = localTop + Math.floor(saved.index / layout.current.columns) * layout.current.rowHeight + saved.delta
        restored = true
      }
      const top = Math.max(0, scroller.scrollTop - localTop)
      anchor.current = { index: Math.floor(top / layout.current.rowHeight) * layout.current.columns, delta: top % layout.current.rowHeight }
      setGeometry({ width: element.clientWidth, top, height: scroller.clientHeight })
      if (restored) {
        const { columns, rowHeight } = layout.current
        const start = Math.max(0, Math.floor(top / rowHeight) - 1) * columns
        const end = Math.min(latest.current.data.total, (Math.ceil((top + scroller.clientHeight) / rowHeight) + 1) * columns)
        if (end > start) latest.current.data.onVisibleRange(start, end - 1)
      }
    }
    const scroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        update()
        const top = Math.max(0, scroller.getBoundingClientRect().top - element.getBoundingClientRect().top)
        const index = Math.min(Math.max(0, latest.current.data.total - 1), Math.floor(top / layout.current.rowHeight) * layout.current.columns)
        if (remember) { memories.delete(scope); memories.set(scope, { index, delta: top % layout.current.rowHeight, key: latest.current.data.getItem(index) ? latest.current.itemKey(latest.current.data.getItem(index)!) : undefined }) }
        while (memories.size > 20) memories.delete(memories.keys().next().value!)
        latest.current.onAnchor?.(index)
      })
    }
    measure.current = update
    const resize = new ResizeObserver(update)
    resize.observe(element); resize.observe(scroller)
    scroller.addEventListener('scroll', scroll, { passive: true }); update()
    return () => { measure.current = null; cancelAnimationFrame(frame); resize.disconnect(); scroller.removeEventListener('scroll', scroll) }
  }, [scope, contained, remember, scrollRef, hasItems, minWidth, gap, pageSize])
  useLayoutEffect(() => {
    const element = root.current
    if (!element || !hasItems) return
    const scroller = contained ? viewport.current! : scrollRef?.current ?? scrollingParent(element)
    const before = appliedLayout.current
    if (before.columns !== columns || before.rowHeight !== rowHeight || anchor.current.index >= data.total) {
      const saved = anchor.current
      const localTop = scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      const next = Math.floor(Math.min(saved.index, data.total - 1) / columns) * rowHeight + Math.min(saved.delta, rowHeight - 1)
      // Above-list metadata remains visible if scrolling has not entered the grid.
      if (saved.index || saved.delta) scroller.scrollTop = localTop + next
      setGeometry(old => ({ ...old, top: Math.max(0, scroller.scrollTop - localTop) }))
    }
    appliedLayout.current = { columns, rowHeight }
  }, [columns, rowHeight, data.total, hasItems, contained, scrollRef])
  useLayoutEffect(() => { measure.current?.() }, [columns, rowHeight, data.total])
  useLayoutEffect(() => {
    if (!focus) return
    if (focus.key !== undefined && !focus.pending) {
      const moved = data.findIndex(item => itemKey(item) === focus.key)
      if (moved >= 0 && moved !== focus.index) { setFocus({ ...focus, index: moved, pending: true }); return }
    }
    if (!data.getItem(focus.index)) {
      if (!focus.pending && document.activeElement === document.body) root.current?.querySelector<HTMLElement>(`[data-index="${focus.index}"]`)?.focus({ preventScroll: true })
      return
    }
    if (!focus.pending) return
    const cell = root.current?.querySelector<HTMLElement>(`[data-index="${focus.index}"]`)
    const target = cell?.querySelector<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]') ?? cell
    if (target) { target.focus({ preventScroll: true }); setFocus({ ...focus, pending: false, key: itemKey(data.getItem(focus.index)!) }) }
  }, [data, focus, itemKey])
  const indices = Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
  if (focus && focus.index < data.total && !indices.includes(focus.index)) indices.push(focus.index)
  return <div ref={viewport} className={contained ? `${styles.viewport}${fill ? ` ${styles.fill}` : ''}` : styles.external}>
    <div ref={root} className={styles.grid} role={role} aria-multiselectable={role === 'listbox' ? multiSelect : undefined} aria-label={label} aria-busy={data.loading}
      style={{ height: Math.max(rows * rowHeight, data.loading || data.error ? 64 : 0) }}
      onKeyDown={event => {
        if ((event.target as HTMLElement).matches('input:not([type="checkbox"]):not([type="radio"]),textarea,select,[contenteditable="true"]')) return
        const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-index]')
        if (!cell) return
        const index = Number(cell.dataset.index)
        const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key]
        if (step === undefined) return
        const next = index + step
        if (next < 0 || next >= data.total) return
        event.preventDefault()
        setFocus({ index: next, pending: true }); data.onVisibleRange(next, next)
        const scroller = contained ? viewport.current! : scrollRef?.current ?? scrollingParent(root.current!)
        const top = scroller.scrollTop + root.current!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + Math.floor(next / columns) * rowHeight
        if (top < scroller.scrollTop) scroller.scrollTop = top
        else if (top + rowHeight > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + rowHeight - scroller.clientHeight
      }}>
      {indices.map(index => {
        const item = data.getItem(index)
        return <div key={`${scope}:${index}`} data-item-key={item ? itemKey(item) : undefined} data-index={index} className={styles.cell} tabIndex={-1}
          onFocusCapture={() => setFocus({ index, pending: false, key: item ? itemKey(item) : focus?.index === index ? focus.key : undefined })}
          style={{ width, height: rowHeight - gap, left: index % columns * (width + gap), top: Math.floor(index / columns) * rowHeight }}>
          {item ? renderItem(item, index) : <div className={styles.placeholder} aria-label="正在加载" />}
        </div>
      })}
      {data.loading && <span role="status">读取中…</span>}
      {!data.loading && !data.error && data.total === 0 && <span role="status">{emptyLabel}</span>}
    </div>
    {data.error && <div className={styles.error} role="alert">{data.error}<Button size="sm" onClick={data.retry}>重试</Button></div>}
  </div>
}
