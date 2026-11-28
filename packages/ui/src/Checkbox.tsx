import type { InputHTMLAttributes } from 'react'
import styles from './Checkbox.module.css'

export default function Checkbox({ className = '', indeterminate = false, ...props }:
  Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { indeterminate?: boolean }
): JSX.Element {
  return <input {...props} type="checkbox" className={`${styles.input} ${className}`}
    ref={element => { if (element) element.indeterminate = indeterminate }} />
}
