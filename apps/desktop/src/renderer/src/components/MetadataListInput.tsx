import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Plus } from 'lucide-react'
import { useDebounce } from '../hooks/useDebounce'
import ChipRemoveButton from './ChipRemoveButton'
import FloatingLayer from './FloatingLayer'
import { UI_ICON_SM } from './iconDefaults'
import { appendMetadataList, metadataListKey, type MetadataListDraft } from './metadataListDraft'
import styles from './MetadataListInput.module.css'

export interface MetadataListOption {
  key: string
  name: string
  description?: string
  disabled?: boolean
}

interface Props {
  id: string
  label: string
  value: MetadataListDraft
  onChange: (value: MetadataListDraft) => void
  search: (query: string) => Promise<MetadataListOption[]>
  disabled?: boolean
}

/** Draft-only multi-value input. Suggestions never create or update catalog records. */
export default function MetadataListInput({ id, label, value, onChange, search, disabled = false }: Props): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [width, setWidth] = useState<number>()
  const [feedback, setFeedback] = useState('')
  const [result, setResult] = useState<{ query: string; options: MetadataListOption[]; error?: boolean }>()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = value.input.trim()
  const debounced = useDebounce(query, 200)
  const show = open && Boolean(query) && !disabled
  const options = result?.query === query ? result.options : []
  const loading = show && (query !== debounced || result?.query !== query)
  const error = result?.query === query && result.error
  const alreadyAdded = value.values.some(name => metadataListKey(name) === metadataListKey(query))
  const canCreate = !alreadyAdded && !options.some(option => !option.disabled && metadataListKey(option.name) === metadataListKey(query))
  const count = options.length + (canCreate ? 1 : 0)
  const listId = `${id}-options`
  const dismiss = useCallback(() => { setOpen(false); setActive(-1) }, [])

  useEffect(() => {
    if (!show || !debounced || query !== debounced) return
    let current = true
    void search(debounced.slice(0, 500)).then(options => {
      if (current) { setResult({ query: debounced, options }); setActive(-1) }
    }, () => {
      if (current) setResult({ query: debounced, options: [], error: true })
    })
    return () => { current = false }
  }, [debounced, query, search, show])

  useLayoutEffect(() => {
    if (!show) return
    const update = (): void => setWidth(rootRef.current?.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined' || !rootRef.current) return
    const observer = new ResizeObserver(update)
    observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [show])

  const commit = (input: string | string[] = value.input): void => {
    const next = appendMetadataList(value.values, input)
    onChange({ values: next.values, input: '' })
    setFeedback(next.duplicates ? `已忽略 ${next.duplicates} 个重复项` : '')
    dismiss()
  }
  const choose = (index: number): void => {
    const option = options[index]
    if (option?.disabled) return
    if (option) commit([option.name])
    else if (canCreate && index === options.length) commit()
  }
  const popup = show ? <div className={styles.options}>
    <div id={listId} role="listbox" aria-label={`${label}候选`}>
      {options.map((option, index) => {
        const selected = value.values.some(name => metadataListKey(name) === metadataListKey(option.name))
        return <button key={option.key} id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1}
          className={styles.option} disabled={option.disabled} aria-selected={selected} data-active={active === index || undefined}
          onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(index)}>
          <span className={styles.optionText}><span>{option.name}</span>{option.description ? <small className={styles.optionDescription}>{option.description}</small> : null}</span>
          {selected ? <span className={styles.added}><Check {...UI_ICON_SM} aria-hidden />已添加</span> : null}
        </button>
      })}
      {canCreate ? <button id={`${id}-option-${options.length}`} type="button" role="option" aria-selected={false} tabIndex={-1}
        className={`${styles.option} ${styles.create}`} data-active={active === options.length || undefined}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(options.length)} onClick={() => commit()}>
        <Plus {...UI_ICON_SM} aria-hidden /><span>添加新名称「{query}」</span>
      </button> : null}
    </div>
    {loading ? <div className={styles.notice} role="status">搜索中…</div> : error ? <div className={styles.notice} role="status">搜索失败，可直接输入名称添加。</div> : null}
    <div className={styles.keyboard}><span><kbd className={styles.keycap}>Enter</kbd> 添加</span><span><kbd className={styles.keycap}>Esc</kbd> 关闭</span></div>
  </div> : null

  return <div className={styles.root}>
    <div ref={rootRef} className={styles.control} data-disabled={disabled || undefined}
      onClick={event => { if (event.target === event.currentTarget && !disabled) inputRef.current?.focus() }}>
      {value.values.map((name, index) => <span className={styles.chip} key={`${index}-${name}`} data-chip-remove-host>
        <span className={styles.name}>{name}</span>
        <ChipRemoveButton reveal="always" disabled={disabled} label={`移除${label} ${name}`}
          onClick={() => { onChange({ ...value, values: value.values.filter((_, i) => i !== index) }); setFeedback('') }} />
      </span>)}
      <input ref={inputRef} id={id} className={styles.input} role="combobox" aria-label={`添加${label}`} disabled={disabled}
        aria-autocomplete="list" aria-expanded={show} aria-controls={show ? listId : undefined}
        aria-activedescendant={show && active >= 0 && active < count ? `${id}-option-${active}` : undefined}
        autoComplete="off" value={value.input} placeholder={value.values.length ? `搜索或输入${label}…` : `添加${label}…`}
        onChange={event => { onChange({ ...value, input: event.target.value }); setOpen(true); setActive(-1); setFeedback('') }}
        onFocus={() => setOpen(true)}
        onBlur={event => {
          if (event.relatedTarget && rootRef.current?.contains(event.relatedTarget as Node)) return
          if (value.input.trim()) commit()
          else dismiss()
        }}
        onPaste={event => {
          const text = event.clipboardData.getData('text')
          if (!/[,，、\r\n]/.test(text)) return
          event.preventDefault()
          const start = event.currentTarget.selectionStart ?? value.input.length
          const end = event.currentTarget.selectionEnd ?? start
          commit(value.input.slice(0, start) + text + value.input.slice(end))
        }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape' && show) { event.preventDefault(); event.stopPropagation(); dismiss(); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!query || !count) return
            event.preventDefault(); setOpen(true)
            setActive(previous => previous < 0
              ? event.key === 'ArrowDown' ? 0 : count - 1
              : (previous + (event.key === 'ArrowDown' ? 1 : count - 1)) % count)
          } else if (event.key === 'Enter' || /^(,|，|、)$/.test(event.key)) {
            event.preventDefault()
            if (event.key === 'Enter' && show && active >= 0 && active < count) choose(active)
            else if (query) commit()
          } else if (event.key === 'Backspace' && !value.input && value.values.length) {
            event.preventDefault()
            rootRef.current?.querySelectorAll<HTMLButtonElement>('button').item(value.values.length - 1)?.focus()
          }
        }} />
    </div>
    <span className={styles.feedback} role="status">{feedback || 'Enter 添加 · 支持粘贴多个名称'}</span>
    {popup && typeof document !== 'undefined' && typeof document.body?.appendChild === 'function'
      ? <FloatingLayer open anchorRef={rootRef} side="bottom" align="start" offset={4} style={width ? { width } : undefined} onClose={dismiss}>{popup}</FloatingLayer>
      : popup}
  </div>
}
