import { forwardRef, type InputHTMLAttributes } from 'react'
import styles from './Switch.module.css'

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> {
  className?: string
}

/** Shared binary switch. Labels and descriptive copy belong to the calling feature. */
const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className = '', disabled = false, role = 'switch', ...rest },
  ref
): JSX.Element {
  return (
    <span className={`${styles.root}${disabled ? ` ${styles.disabled}` : ''}${className ? ` ${className}` : ''}`}>
      <input ref={ref} type="checkbox" role={role} disabled={disabled} {...rest} />
      <span className={styles.slider} aria-hidden="true" />
    </span>
  )
})

export default Switch
