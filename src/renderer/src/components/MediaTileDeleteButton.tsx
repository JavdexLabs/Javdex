import type { MouseEvent } from 'react'
import { Trash2 } from 'lucide-react'
import IconButton from './IconButton'
import { UI_ICON_SM } from './iconDefaults'

export default function MediaTileDeleteButton({
  label,
  title,
  disabled = false,
  onClick
}: {
  label: string
  title?: string
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    event.preventDefault()
    onClick()
  }

  return (
    <IconButton
      className="media-tile-delete"
      icon={<Trash2 {...UI_ICON_SM} />}
      label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={handleClick}
    />
  )
}
