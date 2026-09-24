import type { HTMLAttributes } from 'react'
import styles from './Spinner.module.css'

export default function Spinner({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={`${styles.root}${className ? ` ${className}` : ''}`} {...props} />
}
