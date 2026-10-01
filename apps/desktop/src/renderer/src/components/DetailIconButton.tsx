import type { ComponentProps } from 'react'
import IconButton from './IconButton'
import styles from './DetailIconButton.module.css'

type DetailIconButtonProps = ComponentProps<typeof IconButton> & { compact?: boolean }

export default function DetailIconButton({
  compact = false,
  className = '',
  ...props
}: DetailIconButtonProps): JSX.Element {
  return (
    <IconButton
      {...props}
      className={`${styles.root}${compact ? ` ${styles.compact}` : ''}${className ? ` ${className}` : ''}`}
    />
  )
}
