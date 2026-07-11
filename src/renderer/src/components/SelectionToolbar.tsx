import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'

export type SelectionToolbarAction = {
  key: string
  label: string
  icon?: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
}

interface SelectionToolbarProps {
  countLabel: string
  actions: SelectionToolbarAction[]
  clearLabel?: string
  onClear: () => void
}

export default function SelectionToolbar({
  countLabel,
  actions,
  clearLabel = '\u53d6\u6d88\u9009\u62e9',
  onClear
}: SelectionToolbarProps): JSX.Element {
  return (
    <div className="selection-toolbar" role="toolbar" aria-label={'\u591a\u9009\u64cd\u4f5c'}>
      <div className="selection-toolbar-count">{countLabel}</div>
      <div className="selection-toolbar-actions">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={`btn btn-sm${action.primary ? ' btn-primary' : ''}${action.danger ? ' btn-danger' : ''}`}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        ))}
      </div>
      <IconButton
        className="selection-toolbar-clear"
        icon={<X {...UI_ICON_SM} />}
        label={clearLabel}
        onClick={onClear}
      />
    </div>
  )
}
