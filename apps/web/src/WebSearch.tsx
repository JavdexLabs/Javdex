import { Search, X } from 'lucide-react'
import WebTextInput from './WebTextInput'
import { WebButton } from './WebButton'
import styles from './WebSearch.module.css'

export default function WebSearch({ value, onChange, onSearch }: {
  value: string; onChange: (value: string) => void; onSearch: (value: string) => void
}): JSX.Element {
  return <form className={styles.root} role="search" onSubmit={event => {
    event.preventDefault()
    onSearch(value.trim())
    if (window.matchMedia('(pointer: coarse)').matches) event.currentTarget.querySelector('input')?.blur()
  }}>
    <Search aria-hidden="true" />
    <WebTextInput id="web-search" type="search" enterKeyHint="search" autoCapitalize="none"
      spellCheck={false} aria-label="搜索番号、片名或演员" placeholder="搜索番号、片名或演员"
      value={value} maxLength={200} onChange={event => onChange(event.target.value)} />
    {value && <WebButton type="button" aria-label="清除搜索" onClick={() => {
      onChange('')
      onSearch('')
    }}><X /></WebButton>}
    <WebButton type="submit" data-web-search-submit tabIndex={-1}>搜索</WebButton>
  </form>
}
