import type { KeyboardEventHandler } from 'react'
import type { ThemeId } from '@shared/settingsTypes'
import styles from './ThemePreview.module.css'

/** Preview a palette without changing the active application theme. */
export function ThemeSwatch({
  theme,
  className = ''
}: {
  theme: ThemeId
  className?: string
}): JSX.Element {
  return (
    <span
      data-theme={theme}
      className={`${styles.palette} ${styles.swatch}${className ? ` ${className}` : ''}`}
      aria-hidden
    />
  )
}

export function ThemeChoice({
  option,
  selected,
  onClick,
  onKeyDown
}: {
  option: { id: ThemeId; label: string; hint: string }
  selected: boolean
  onClick: () => void
  onKeyDown: KeyboardEventHandler<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      type="button"
      data-theme={option.id}
      className={`${styles.palette} ${styles.choice}`}
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <ThemeSwatch theme={option.id} />
      <span className={styles.label}>{option.label}</span>
      <span className={styles.hint}>{option.hint}</span>
    </button>
  )
}
