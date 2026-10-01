import type { ReactNode } from 'react'
import styles from './StatusText.module.css'

export default function StatusText({
  as: Tag,
  tone,
  id,
  children
}: {
  as: 'strong' | 'small' | 'p'
  tone: 'success' | 'danger'
  id?: string
  children: ReactNode
}): JSX.Element {
  return <Tag id={id} className={styles[tone]}>{children}</Tag>
}
