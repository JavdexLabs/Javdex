import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import Button from './Button'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'
import styles from './SelectionToolbar.module.css'

export type SelectionToolbarAction = {
  key: string
  label: string
  icon?: ReactNode
  onClick: () => void
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  title?: string
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
      <div className={`${styles.actions} selection-toolbar-actions`}>
        {actions.map((action) => (
          <Button
            key={action.key}
            type="button"

            size="sm"
            variant={action.danger ? 'danger' : action.primary ? 'primary' : 'default'}
            disabled={action.disabled}
            title={action.title}
            onClick={action.onClick}
          >
            {action.icon}
            <span>{action.label}</span>
          </Button>
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
