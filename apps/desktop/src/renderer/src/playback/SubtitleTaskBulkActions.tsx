import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Eraser, Pause, Play, Trash2 } from 'lucide-react'
import { canApplySubtitleBulkOperation, type SubtitleBulkOperation, type SubtitleTaskCommand, type SubtitleTaskView } from '@shared/desktop/subtitleTasks'
import Button from '../components/Button'
import ConfirmModal from '../components/ConfirmModal'
import type { SubtitleTaskFilter } from '../tasks/taskCenterState'
import styles from './SubtitleTasks.module.css'

const actions = {
  resume: { label: '全部开始', icon: Play },
  pause: { label: '全部暂停', icon: Pause },
  'remove-active': { label: '全部移除', icon: Trash2 },
  'clear-completed': { label: '清空全部记录', icon: Eraser }
}
const byFilter: Record<SubtitleTaskFilter, SubtitleBulkOperation[]> = {
  active: ['resume', 'pause', 'remove-active'], attention: [], finished: ['clear-completed']
}

export default function SubtitleTaskBulkActions({ filter, tasks, disabled, execute }: {
  filter: SubtitleTaskFilter; tasks: SubtitleTaskView[]; disabled: boolean
  execute(command: SubtitleTaskCommand): Promise<boolean>
}): JSX.Element | null {
  const [confirm, setConfirm] = useState<{ operation: 'remove-active' | 'clear-completed'; ids: string[] } | null>(null)
  if (!byFilter[filter].length) return null
  return <div className={styles.bulkActions} role="group" aria-label="字幕任务快捷操作">
    {byFilter[filter].map(operation => {
      const { label, icon: Icon } = actions[operation]
      return <Button key={operation} size="sm" variant="ghost" disabled={disabled || !tasks.some(job => canApplySubtitleBulkOperation(job.status, operation))}
        onClick={() => {
          const ids = tasks.filter(job => canApplySubtitleBulkOperation(job.status, operation)).map(job => job.id)
          if (operation === 'remove-active' || operation === 'clear-completed') setConfirm({ operation, ids })
          else void execute({ action: 'bulk', operation, ids })
        }}><Icon size={14} aria-hidden="true" />{label}</Button>
    })}
    {confirm && createPortal(<ConfirmModal title={confirm.operation === 'remove-active' ? '移除进行中和已暂停的任务？' : '清空已完成的记录？'}
      confirmText={confirm.operation === 'remove-active' ? '确认移除任务' : '确认清空记录'} cancelText="返回" danger
      onCancel={() => setConfirm(null)} onConfirm={() => { void execute({ action: 'bulk', ...confirm }); setConfirm(null) }}>
      {confirm.operation === 'remove-active'
        ? `将移除这 ${confirm.ids.length} 项任务及其生成进度。以后需要重新创建任务。`
        : `将移除这 ${confirm.ids.length} 项任务的记录和中间结果。已保存的字幕文件会保留。`}
    </ConfirmModal>, document.body)}
  </div>
}
