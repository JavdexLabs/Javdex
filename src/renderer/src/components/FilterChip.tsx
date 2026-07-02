import { X } from 'lucide-react'
import { UI_ICON_MD } from './iconDefaults'

interface Props {
  label: string
  onRemove: () => void
}

/** Removable active-filter chip for the library top bar. */
export default function FilterChip({ label, onRemove }: Props): JSX.Element {
  return (
    <button type="button" className="filter-chip" onClick={onRemove} title={`移除：${label}`}>
      <span>{label}</span>
      <span className="filter-chip-x" aria-hidden>
        <X {...UI_ICON_MD} />
      </span>
    </button>
  )
}
