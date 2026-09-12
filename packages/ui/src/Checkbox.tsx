import type { InputHTMLAttributes } from 'react'
import styles from './Checkbox.module.css'

export default function Checkbox({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>): JSX.Element {
  return <input {...props} type="checkbox" className={`${styles.input} ${className}`} />
}
