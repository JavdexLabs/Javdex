import { ArrowDown, ArrowUp } from 'lucide-react'
import IconButton from './IconButton'
import SelectControl from './SelectControl'
import styles from './SortSwitch.module.css'
import { UI_ICON } from './iconDefaults'

export interface SortSwitchOption<T extends string> {
  value: T
  label: string
  title?: string
}

interface Props<T extends string> {
  label: string
  options: SortSwitchOption<T>[]
  value: T
  dir: 'asc' | 'desc'
  onChange: (value: T, dir: 'asc' | 'desc') => void
  compact?: boolean
  quickValues?: T[]
}

export default function SortSwitch<T extends string>({
  label,
  options,
  value,
  dir,
  onChange,
  compact = false,
  quickValues
}: Props<T>): JSX.Element {
  const active = options.find((option) => option.value === value)
  const nextDir = dir === 'asc' ? 'desc' : 'asc'
  const moreActive = quickValues && !quickValues.includes(value)

  return (
    <div className={styles.root} data-compact={compact || undefined} aria-label={label}>
      <div className={styles.fields} role="group" aria-label={`${label}字段`}>
        {options.filter((option) => !quickValues || quickValues.includes(option.value)).map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.field}
            onClick={() => onChange(option.value, dir)}
            title={option.title ?? option.label}
            aria-pressed={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
      {quickValues && (
        <SelectControl
          className={styles.more}
          buttonClassName={`${styles.moreButton}${moreActive ? ` ${styles.selected}` : ''}`}
          aria-label={`${label}全部选项`}
          value={value}
          displayLabel="更多"
          onChange={(event) => onChange(event.target.value as T, dir)}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.title ?? option.label}</option>
          ))}
        </SelectControl>
      )}
      <IconButton
        className={styles.direction}
        icon={dir === 'asc' ? <ArrowUp {...UI_ICON} /> : <ArrowDown {...UI_ICON} />}
        label={`${active?.title ?? active?.label ?? label}${dir === 'asc' ? '升序' : '降序'}`}
        title={dir === 'asc' ? '升序' : '降序'}
        onClick={() => onChange(value, nextDir)}
      />
    </div>
  )
}
