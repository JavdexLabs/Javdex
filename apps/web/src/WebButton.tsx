import { forwardRef, type ButtonHTMLAttributes, type AnchorHTMLAttributes } from 'react'
import styles from './WebButton.module.css'

export const WebButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'chip'
}>(function WebButton({ variant = 'default', className = '', ...props }, ref) {
  return <button {...props} ref={ref} data-variant={variant}
    className={`${styles.control} ${styles.button} ${variant === 'chip' ? styles.chip : ''} ${className}`} />
})

export const WebChipLink = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function WebChipLink({ className = '', ...props }, ref) {
    return <a {...props} ref={ref} className={`${styles.control} ${styles.chip} ${className}`} />
  }
)
