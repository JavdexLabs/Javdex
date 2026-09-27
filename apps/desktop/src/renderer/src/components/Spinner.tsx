import type { HTMLAttributes } from 'react'
import styles from './Spinner.module.css'

export default function Spinner({ className = '', size = 'default', ...props }: HTMLAttributes<HTMLDivElement> & { size?: 'default' | 'sm' }): JSX.Element {
  return <div className={`${styles.root}${size === 'sm' ? ` ${styles.compact}` : ''}${className ? ` ${className}` : ''}`} {...props} />
}
