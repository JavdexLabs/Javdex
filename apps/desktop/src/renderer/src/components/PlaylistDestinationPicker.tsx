import styles from './PlaylistDestinationPicker.module.css'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ListVideo, Search } from 'lucide-react'
import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import { useDebounce } from '../hooks/useDebounce'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import ContinuousGrid from './ContinuousGrid'
import EmptyState from './EmptyState'
import Button from './Button'
import PlaylistPickerRow from './PlaylistPickerRow'
import TextInput from './TextInput'
import FloatingLayer from './FloatingLayer'
import { UI_ICON, UI_ICON_SM } from './iconDefaults'

export default function PlaylistDestinationPicker({ value, label, onChange, disabled = false }: {
  value: string; label?: string; onChange: (id: string, label: string) => void; disabled?: boolean
}): JSX.Element {
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const [popupWidth, setPopupWidth] = useState<number>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const popupId = useId()
  const expanded = open && !disabled
  const selectedLabel = value ? label || `清单 #${value}` : '选择目标清单'
  const search = useDebounce(input.trim(), 250)
  const pendingSearch = input.trim() !== search
  const page = usePlaylistBrowsePage({ search, limit: 60, kind: 'custom' }, expanded)
  const dismiss = useCallback(() => setOpen(false), [])

  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!expanded) return
    // A newly portaled layer stays hidden until its position has been measured.
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [expanded])
  useLayoutEffect(() => {
    if (!expanded) return
    const measure = (): void => {
      const width = triggerRef.current?.getBoundingClientRect().width
      if (width) setPopupWidth(Math.min(Math.max(width, 240), window.innerWidth - 16))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [expanded])

  const show = (): void => {
    setInput('')
    setOpen(true)
  }
  const select = (item: PlaylistBrowseItem): void => {
    if (disabled || pendingSearch || page.loading) return
    onChange(String(item.id), item.name)
    dismiss()
    triggerRef.current?.focus()
  }
  const candidates = expanded ? (
    <div ref={popupRef} id={popupId} role="dialog" aria-label="选择目标清单" className={styles.popup}
      onBlur={event => {
        const next = event.relatedTarget as Node | null
        if (next && !event.currentTarget.contains(next) && !triggerRef.current?.contains(next)) dismiss()
      }}>
      <div className={styles.searchField}>
        <Search {...UI_ICON} className={styles.searchIcon} />
        <TextInput ref={searchRef} className={styles.search} aria-label="搜索目标清单" placeholder="搜索目标清单"
          maxLength={500} value={input} autoComplete="off" spellCheck={false}
          onChange={event => setInput(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
              event.preventDefault()
              if (pendingSearch || page.loading) return
              const rows = popupRef.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)')
              const target = event.key === 'ArrowUp' ? rows?.[rows.length - 1] : rows?.[0]
              target?.focus()
            }
          }} />
      </div>
      <div className={styles.list} aria-busy={pendingSearch || page.loading}>
        {page.loading ? <EmptyState variant="modal" loading /> : page.error && !page.total ? (
          <EmptyState variant="modal" title="清单读取失败" description={page.error}><Button size="sm" onClick={page.reload}>重试</Button></EmptyState>
        ) : !page.total ? <EmptyState variant="modal" title={search ? '没有匹配的清单' : '暂无播放清单'} /> : (
          <ContinuousGrid contained fill window={page.window} scope={`playlist-destination:${search}`} label="目标清单候选"
            role="listbox" itemHeight={56} gap={0} itemKey={item => item.id}
            renderItem={item => <PlaylistPickerRow key={item.id} item={item} variant="option" disabled={disabled || pendingSearch}
              selected={String(item.id) === value} onSelect={() => select(item)} />} />
        )}
      </div>
    </div>
  ) : null
  const canPortal = typeof document !== 'undefined' && typeof document.body?.appendChild === 'function'
  return <div className={styles.root}>
    <button ref={triggerRef} type="button" className={styles.trigger} disabled={disabled} title={selectedLabel}
      aria-label={value ? `目标清单：${selectedLabel}` : '选择目标清单'} aria-haspopup="dialog"
      aria-expanded={expanded} aria-controls={expanded ? popupId : undefined} data-empty={!value || undefined}
      onClick={() => expanded ? dismiss() : show()}
      onBlur={event => {
        const next = event.relatedTarget as Node | null
        if (expanded && next && !popupRef.current?.contains(next)) dismiss()
      }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show() }
      }}>
      <ListVideo {...UI_ICON} />
      <span className={styles.value} aria-live="polite">{selectedLabel}</span>
      <ChevronDown {...UI_ICON_SM} className={styles.chevron} />
    </button>
    {canPortal ? <FloatingLayer open={expanded} anchorRef={triggerRef} side="bottom" align="start" offset={4}
      className={styles.layer} style={popupWidth ? { width: popupWidth } : undefined} onClose={dismiss}>
      {candidates}
    </FloatingLayer> : candidates}
  </div>
}
