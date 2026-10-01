import type { MouseEventHandler } from 'react'
import styles from './CardSelectionButton.module.css'

export default function CardSelectionButton({ selected, visible, label, onClick }: {
  selected: boolean
  visible: boolean
  label: string
  onClick: MouseEventHandler<HTMLButtonElement>
}): JSX.Element {
  return <button type="button" className={styles.root} data-visible={visible || undefined}
    aria-label={label} aria-pressed={selected} onClick={onClick} />
}
