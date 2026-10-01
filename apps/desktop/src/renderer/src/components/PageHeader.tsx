import type { HTMLAttributes } from 'react'
import styles from './PageHeader.module.css'

export default function PageHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} className={`${styles.root} ${className}`} />
}
