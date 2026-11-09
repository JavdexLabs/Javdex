import { useId, useRef, useState } from 'react'
import { Captions, Check, ChevronDown, ChevronUp, CircleAlert, Ellipsis, Pause, Play } from 'lucide-react'
import type { SubtitleTaskCommand, SubtitleTaskStatus, SubtitleTaskView } from '@shared/desktop/subtitleTasks'
import Button from '../components/Button'
import IconButton from '../components/IconButton'
import FloatingLayer from '../components/FloatingLayer'
import { DetailMenuItem, DetailMenuSeparator } from '../components/DetailMenu'
import { subtitleProgress } from '../tasks/taskCenterState'
import { playbackTime } from './playbackTime'
import styles from './SubtitleTasks.module.css'

const labels: Record<SubtitleTaskStatus, string> = {
  queued: '排队中', running: '生成中', paused: '已暂停', failed: '需处理', saving: '保存中',
  'awaiting-save': '待保存', completed: '已保存', cancelled: '已取消'
}

function taskName(job: SubtitleTaskView): string {
  const title = job.title.trim()
  if (title && title !== '影片播放') return title
  return job.outputName?.replace(/\.(?:zh-ja|ja)\.ai\.(?:ass|srt)$/i, '').replace(/\.(?:ass|srt)$/i, '') || `影片资源 ${job.target.resourceId}`
}

export default function SubtitleTaskRow({ job, busy, error, execute }: {
  job: SubtitleTaskView; busy: boolean; error?: string
  execute(command: SubtitleTaskCommand): Promise<boolean>
}): JSX.Element {
  const name = taskName(job), detailId = useId(), menuId = useId()
  const [expanded, setExpanded] = useState(false), [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState<'remove' | 'delete-output' | null>(null)
  const menuButton = useRef<HTMLButtonElement>(null), firstMenuItem = useRef<HTMLButtonElement>(null)
  const attention = job.status === 'failed' || job.status === 'awaiting-save'
  const statusTone = attention ? 'warning' : job.status === 'completed' ? 'success' : ['running', 'saving'].includes(job.status) ? 'accent' : 'neutral'
  const progress = subtitleProgress(job)
  const canExport = job.status === 'completed' || job.status === 'awaiting-save'
  const canCancel = !['completed', 'cancelled', 'saving'].includes(job.status)
  const canRemove = !['running', 'saving'].includes(job.status)
  const primary = ['paused', 'failed', 'cancelled'].includes(job.status) ? { action: 'resume', label: '继续', icon: <Play size={14} /> }
    : ['queued', 'running'].includes(job.status) ? { action: 'pause', label: '暂停', icon: <Pause size={14} /> }
      : job.status === 'awaiting-save' ? { action: 'retry-save', label: '重试保存', icon: null }
        : null
  const command = (action: Exclude<SubtitleTaskCommand['action'], 'enqueue'>): void => {
    setMenu(false)
    void execute({ action, id: job.id })
  }
  const requestRemoval = (action: 'remove' | 'delete-output'): void => { setMenu(false); setConfirm(action) }
  return <section className={styles.row} aria-label={name} data-status={job.status}>
    <div className={styles.rowMain}>
      <div className={styles.identity}>
        <span className={styles.fileIcon}><Captions size={20} /></span>
        <div className={styles.identityText}>
          <h2 className={styles.name} title={name}>{name}</h2>
          <p className={styles.meta}>{job.output === 'bilingual' ? '日中双语' : '日语'}<span>·</span>音轨 {job.audioIndex + 1}<span>·</span>{playbackTime(job.duration)}</p>
        </div>
      </div>
      <div className={styles.progressColumn}>
        <div className={styles.progressLabel}><span>{job.status === 'completed' ? '生成完成' : job.status === 'queued' ? '等待执行' : '生成进度'}</span><span>{progress == null ? '—' : `${progress}%`}</span></div>
        {progress != null && <progress className={styles.progress} max={100} value={progress} aria-label={`${name}生成进度`} />}
        <p className={styles.progressHint}>{job.status === 'completed' ? '字幕文件已保存' : job.output === 'bilingual' ? `已译 ${playbackTime(job.translatedSeconds)}` : `已识别 ${playbackTime(job.recognizedSeconds)}`}</p>
      </div>
      <span className={styles.status} data-tone={statusTone}>
        {attention ? <CircleAlert size={13} /> : job.status === 'completed' ? <Check size={13} /> : <span className={styles.dot} />}{labels[job.status]}
      </span>
      <div className={styles.actions}>
        {primary ? <Button size="sm" disabled={busy} onClick={() => command(primary.action as 'resume' | 'pause' | 'retry-save')}>{primary.icon}{primary.label}</Button>
          : <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '详情'}</Button>}
        <IconButton size="sm" icon={<Ellipsis size={17} />} label={`${name}更多操作`} ref={menuButton} disabled={busy}
          aria-haspopup="menu" aria-expanded={menu} aria-controls={menu ? menuId : undefined} onClick={() => setMenu(!menu)} />
        <FloatingLayer open={menu} anchorRef={menuButton} initialFocusRef={firstMenuItem} side="bottom" align="end" id={menuId} onClose={() => setMenu(false)}>
          <div className={styles.menu} role="menu" aria-label={`${name}操作`} onKeyDown={event => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            }
            if (event.key === 'Tab') setMenu(false)
          }}>
            <DetailMenuItem ref={firstMenuItem} onClick={() => { setMenu(false); setExpanded(!expanded) }}>{expanded ? '收起详情' : '查看详情'}</DetailMenuItem>
            {canExport && <><DetailMenuItem disabled={busy} onClick={() => command('save-as')}>另存／替换</DetailMenuItem><DetailMenuItem disabled={busy} onClick={() => command('export-srt')}>导出 SRT</DetailMenuItem></>}
            {(canCancel || canRemove) && <DetailMenuSeparator />}
            {canCancel && <DetailMenuItem disabled={busy} onClick={() => command('cancel')}>取消任务</DetailMenuItem>}
            {job.status === 'completed' && <DetailMenuItem danger disabled={busy} onClick={() => requestRemoval('delete-output')}>删除生成字幕</DetailMenuItem>}
            {canRemove && <DetailMenuItem danger disabled={busy} onClick={() => requestRemoval('remove')}>移除任务</DetailMenuItem>}
          </div>
        </FloatingLayer>
      </div>
    </div>
    {(job.error || error) && <div className={styles.feedback} data-tone={error ? 'danger' : 'warning'} role={error ? 'alert' : undefined}>
      <CircleAlert size={14} /><span className={styles.feedbackText}>{error || job.error}</span>
      <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '查看详情'}{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</Button>
    </div>}
    {expanded && <div id={detailId} className={styles.details}>
      <dl className={styles.detailGrid}>
        <div><dt>影片</dt><dd>{name}</dd></div>
        <div><dt>输出文件</dt><dd>{job.outputName || '保存后显示文件名'}</dd></div>
        <div><dt>处理进度</dt><dd>识别 {playbackTime(job.recognizedSeconds)}{job.output === 'bilingual' && ` · 翻译 ${playbackTime(job.translatedSeconds)}`} / {playbackTime(job.duration)}</dd></div>
        {job.status === 'queued' && <div><dt>排队说明</dt><dd>等待前面的任务，或等待其他影片播放结束。</dd></div>}
        {job.status === 'cancelled' && <div><dt>任务说明</dt><dd>已取消，断点保留，可继续未完成部分。</dd></div>}
        {(error || job.error) && <div><dt>问题详情</dt><dd className={styles.error}>{error || job.error}</dd></div>}
      </dl>
    </div>}
    {confirm && <div className={styles.confirm} role="group" aria-label="确认字幕操作">
      <div><strong>{confirm === 'remove' ? '移除这个任务？' : '删除生成的字幕文件？'}</strong><p className={styles.confirmText}>{confirm === 'remove' ? '移除任务及中间结果，已保存的字幕文件保留。' : `将删除 ${job.outputName ?? name}，生成结果保留，可重新保存。`}</p></div>
      <div className={styles.confirmActions}>
        <Button size="sm" disabled={busy} onClick={() => { setConfirm(null); menuButton.current?.focus() }}>返回</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => { void execute({ action: confirm, id: job.id }).then(ok => { if (ok) setConfirm(null) }) }}>确认{confirm === 'remove' ? '移除' : '删除'}</Button>
      </div>
    </div>}
  </section>
}
