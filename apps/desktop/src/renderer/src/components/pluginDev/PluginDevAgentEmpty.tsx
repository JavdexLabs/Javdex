import type { ReactNode } from 'react'
import EmptyState from '../EmptyState'
import styles from './PluginDevAgentEmpty.module.css'

export default function PluginDevAgentEmpty({
  icon,
  title,
  description,
  className
}: {
  icon: ReactNode
  title: string
  description: string
  className?: string
}): JSX.Element {
  return <EmptyState variant="fill" className={`${styles.root}${className ? ` ${className}` : ''}`} icon={icon} title={title} description={description} />
}
