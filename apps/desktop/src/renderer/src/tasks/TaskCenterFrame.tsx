import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import IconButton from '../components/IconButton'
import { TASK_LABELS, TASK_TABS, taskCenterPath, type TaskTab } from './taskCenterRoutes'
import styles from './TaskCenter.module.css'

export default function TaskCenterFrame({ tab, children, onRefresh, refreshing = false }: {
  tab: TaskTab; children: ReactNode; onRefresh?: () => void; refreshing?: boolean
}): JSX.Element {
  return <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.heading}><div><h1>任务中心</h1><p>查看后台进度，处理需要确认的事项。</p></div>
        {onRefresh && <IconButton label="刷新任务" icon={<RefreshCw size={18} />} disabled={refreshing} onClick={onRefresh} />}
      </div>
      <nav className={styles.tabs} aria-label="任务分类">
        {TASK_TABS.map(value => <Link draggable={false} key={value} to={taskCenterPath(value)} aria-current={tab === value ? 'page' : undefined}>{TASK_LABELS[value]}</Link>)}
      </nav>
    </header>
    {children}
  </div>
}
