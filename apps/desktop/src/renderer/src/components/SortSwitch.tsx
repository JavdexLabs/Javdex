import { ChevronDown, ChevronUp } from 'lucide-react'
import IconButton from './IconButton'
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
}

export default function SortSwitch<T extends string>({
  label,
  options,
  value,
  dir,
  onChange,
  compact = false
}: Props<T>): JSX.Element {
  const active = options.find((option) => option.value === value)
  const nextDir = dir === 'asc' ? 'desc' : 'asc'

  return (
    <div className={`sort-switch${compact ? ' sort-switch--compact' : ''}`} aria-label={label}>
      <div className="sort-switch-fields" role="group" aria-label={`${label}字段`}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`sort-switch-field${option.value === value ? ' is-active' : ''}`}
            onClick={() => onChange(option.value, dir)}
            title={option.title ?? option.label}
            aria-pressed={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
      <IconButton
        className="sort-switch-dir"
        icon={dir === 'asc' ? <ChevronUp {...UI_ICON} /> : <ChevronDown {...UI_ICON} />}
        label={`${active?.title ?? active?.label ?? label}${dir === 'asc' ? '升序' : '降序'}`}
        title={dir === 'asc' ? '升序' : '降序'}
        onClick={() => onChange(value, nextDir)}
      />
    </div>
  )
}
