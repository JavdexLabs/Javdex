import type { ReactNode, Ref } from 'react'
import styles from './ListToolbar.module.css'
import SearchInput from './SearchInput'

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
    <SearchInput
      id={search.id}
      ref={search.inputRef}
      variant="toolbar"
      withAdornment={Boolean(search.endAdornment)}
      placeholder={search.placeholder}
      value={search.value}
      onChange={(e) => search.onChange(e.target.value)}
      aria-label={search.ariaLabel}
      aria-busy={search.busy || undefined}
    />
  ) : null

  return (
    <div className={styles.root}>
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
        <div className={styles.title}>{title}</div>
      )}

      {controls || resultCount ? (
        <div className={styles.end}>
          {controls && <div className={styles.controls}>{controls}</div>}
          {resultCount}
        </div>
      ) : null}
    </div>
  )
}
