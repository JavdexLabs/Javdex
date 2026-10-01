import type { MouseEvent, ReactNode } from 'react'
import { Trash2, X } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'
import styles from './MediaTileActionButton.module.css'

type MediaTileAction = 'delete' | 'remove'

export default function MediaTileActionButton({
  action = 'delete',
  icon,
  label,
  title,
  className = '',
  disabled = false,
  onClick
}: {
  action?: MediaTileAction
  icon?: ReactNode
  label: string
  title?: string
  className?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    // Pointer-triggered modals should not restore focus to a hidden overlay action.
    // Keyboard and assistive-technology clicks have detail === 0 and retain focus.
    if (event.detail !== 0) event.currentTarget.blur()
    onClick()
  }

  return (
    <IconButton
      className={[
        styles.root,
        className
      ]
        .filter(Boolean)
        .join(' ')}
      tone={action === 'delete' ? 'danger' : 'default'}
      data-action={action}
      icon={icon ?? (action === 'delete' ? <Trash2 {...UI_ICON_SM} /> : <X {...UI_ICON_SM} />)}
      label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={handleClick}
    />
  )
}
