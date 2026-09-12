import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import styles from './IconButton.module.css'

export type IconButtonTone = 'default' | 'danger'
export type IconButtonSize = 'md' | 'sm'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: ReactNode
  /** Accessible name; also used as title when title is omitted. */
  label: string
  title?: string
  tone?: IconButtonTone
  size?: IconButtonSize
}

/** Square control with a centered SVG icon glyph. */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    title,
    tone = 'default',
    size = 'md',
    className = '',
    type = 'button',
    ...rest
  },
  ref
): JSX.Element {
  const classes = [
    styles.root,
    tone === 'danger' ? styles.danger : '',
    size === 'sm' ? styles.sm : '',
    'icon-btn',
    tone === 'danger' ? 'icon-btn--danger' : '',
    className
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      data-ui="icon-button"
      aria-label={label}
      title={title ?? label}
      {...rest}
    >
      <span className={`${styles.glyph} icon-btn__glyph`}>{icon}</span>
    </button>
  )
})

export default IconButton
