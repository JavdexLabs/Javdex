import type { ButtonHTMLAttributes } from 'react'
import { X } from 'lucide-react'
import { UI_ICON_SM } from './iconDefaults'
import styles from './ChipRemoveButton.module.css'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label' | 'className'> {
  label: string
  reveal?: 'hover' | 'always'
}

export default function ChipRemoveButton({
  label,
  reveal = 'hover',
  type = 'button',
  ...props
}: Props): JSX.Element {
  return (
    <button {...props} type={type} className={styles.root} data-reveal={reveal} aria-label={label}>
      <X {...UI_ICON_SM} aria-hidden />
    </button>
  )
}
