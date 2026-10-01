import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes } from 'react'
import styles from './SegmentedActions.module.css'

/** Adjacent commands; callers opt into toggle semantics with aria-pressed. */
export function SegmentedActions({ size = 'md', className = '', ...props }:
  HTMLAttributes<HTMLDivElement> & { size?: 'md' | 'sm' }): JSX.Element {
  return <div role="group" {...props} data-size={size} className={`${styles.root} ${className}`} />
}

export const SegmentedAction = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function SegmentedAction({ type = 'button', className = '', ...props }, ref): JSX.Element {
    return <button {...props} ref={ref} type={type} className={`${styles.item} ${className}`} />
  }
)
