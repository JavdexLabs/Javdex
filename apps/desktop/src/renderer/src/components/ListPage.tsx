import type { HTMLAttributes } from 'react'
import styles from './ListPage.module.css'

export default function ListPage({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} className={`${styles.root} ${className}`} />
}
