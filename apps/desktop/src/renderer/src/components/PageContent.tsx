import type { HTMLAttributes } from 'react'
import styles from './PageContent.module.css'

export default function PageContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...props} data-page-content className={`${styles.root} ${className}`} />
}
