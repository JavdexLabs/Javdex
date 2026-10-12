import { forwardRef, type ButtonHTMLAttributes } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost'
export type ButtonSize = 'md' | 'sm'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Replaces the visible content with a centered indicator without changing its layout size. */
  busy?: boolean
}

/** Shared text button. Feature class names may adjust layout, but not visual variants. */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    className = '',
    children,
    type = 'button',
    busy,
    disabled,
    ...rest
  },
  ref
): JSX.Element {
  const classes = [
    styles.root,
    variant === 'default' ? '' : styles[variant],
    size === 'md' ? '' : styles[size],
    className
  ]
    .filter(Boolean)
    .join(' ')

  return <button ref={ref} type={type} className={classes} data-ui="button" {...rest}
    aria-busy={busy ?? rest['aria-busy']}
    disabled={busy ? true : disabled}>
    <span className={styles.content}>{children}</span>
  </button>
})

export default Button
