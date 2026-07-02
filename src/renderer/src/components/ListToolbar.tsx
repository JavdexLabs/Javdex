import type { ReactNode } from 'react'

interface ListToolbarProps {
  leading?: ReactNode
  search?: {
    value: string
    placeholder: string
    ariaLabel: string
    onChange: (value: string) => void
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
  return (
    <div className="topbar-toolbar">
      {leading}
      {search ? (
        <input
          className="search-input topbar-toolbar-search"
          type="search"
          placeholder={search.placeholder}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          aria-label={search.ariaLabel}
        />
      ) : (
        <div className="topbar-toolbar-title">{title}</div>
      )}

      <div className="topbar-toolbar-end">
        {controls && <div className="topbar-toolbar-controls">{controls}</div>}
        {resultCount}
      </div>
    </div>
  )
}
