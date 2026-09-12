import type { ReactNode, Ref } from 'react'
import styles from './ListToolbar.module.css'

interface ListToolbarProps {
  leading?: ReactNode
  search?: {
    value: string
    placeholder: string
    ariaLabel: string
    onChange: (value: string) => void
    id?: string
    inputRef?: Ref<HTMLInputElement>
    busy?: boolean
    endAdornment?: ReactNode
    className?: string
  }
  title?: ReactNode
  controls?: ReactNode
  resultCount?: ReactNode
}

export default function ListToolbar({
  leading,
  search,
  title,
  controls,
  resultCount
}: ListToolbarProps): JSX.Element {
  const searchInput = search ? (
    <input
      id={search.id}
      ref={search.inputRef}
      className={`${styles.search} search-input topbar-toolbar-search`}
      type="search"
      placeholder={search.placeholder}
      value={search.value}
      onChange={(e) => search.onChange(e.target.value)}
      aria-label={search.ariaLabel}
      aria-busy={search.busy || undefined}
    />
  ) : null

  return (
    <div className={`${styles.root} topbar-toolbar`}>
      {leading}
      {search ? (
        search.endAdornment ? (
          <div className={`${styles.searchWrap}${search.className ? ` ${search.className}` : ''}`}>
            {searchInput}
            {search.endAdornment}
          </div>
        ) : (
          searchInput
        )
      ) : (
        <div className={`${styles.title} topbar-toolbar-title`}>{title}</div>
      )}

      {controls || resultCount ? (
        <div className={`${styles.end} topbar-toolbar-end`}>
          {controls && <div className={`${styles.controls} topbar-toolbar-controls`}>{controls}</div>}
          {resultCount}
        </div>
      ) : null}
    </div>
  )
}
