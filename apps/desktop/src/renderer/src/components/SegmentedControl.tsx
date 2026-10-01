import type { ButtonHTMLAttributes, HTMLAttributes } from 'react'
import styles from './SegmentedControl.module.css'

export function SegmentedControl({ variant = 'default', className = '', ...props }:
  HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'toolbar' | 'stretch' }): JSX.Element {
  return <div role="group" {...props} data-variant={variant} className={`${styles.root} ${className}`} />
}

export function SegmentedOption({ selected, className = '', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }): JSX.Element {
  return <button type="button" {...props} aria-pressed={selected} className={`${styles.option} ${className}`} />
}
