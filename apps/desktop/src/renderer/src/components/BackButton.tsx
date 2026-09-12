import type { ButtonHTMLAttributes } from 'react'
import { ChevronLeft } from 'lucide-react'
import { UI_ICON } from './iconDefaults'
import styles from './BackButton.module.css'

interface BackButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** `detail` — above detail content; `inline` — inside a toolbar row. */
  variant?: 'detail' | 'inline'
}

export default function BackButton({
  variant = 'detail',
  className = '',
  type = 'button',
  ...rest
}: BackButtonProps): JSX.Element {
  return (
    <button
      type={type}
      className={`${styles.root}${variant === 'inline' ? ` ${styles.inline}` : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      <span className={styles.icon} aria-hidden>
        <ChevronLeft {...UI_ICON} />
      </span>
      <span className={styles.label}>返回</span>
    </button>
  )
}
