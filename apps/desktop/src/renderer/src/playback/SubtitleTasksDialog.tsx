import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlaybackTarget } from '@shared/desktop/playback'
import type { SubtitlePreparation, SubtitleTaskCommand, SubtitleTasksSnapshot } from '@shared/desktop/subtitleTasks'
import { Captions, Info } from 'lucide-react'
import { api } from '../api'
import Button from '../components/Button'
import Modal from '../components/Modal'
import SelectControl from '../components/SelectControl'
import EmptyState from '../components/EmptyState'
import { SegmentedControl, SegmentedOption } from '../components/SegmentedControl'
import { playbackTime } from './playbackTime'
import SubtitleTaskRow from './SubtitleTaskRow'
import SubtitleFilesPanel from './SubtitleFilesPanel'
import styles from './SubtitleTasks.module.css'
import { matchesSubtitleFilter, type SubtitleTaskFilter } from '../tasks/taskCenterState'

const filters: Array<{ value: SubtitleTaskFilter; label: string; accessible: string }> = [
  { value: 'all', label: '全部', accessible: '全部任务' }, { value: 'active', label: '进行中 / 暂停', accessible: '进行中与已暂停' },
  { value: 'attention', label: '需处理', accessible: '需要处理' }, { value: 'finished', label: '已结束', accessible: '已完成与已取消' }
]

export default function SubtitleTasksDialog({ target, onClose, embedded = false, filter = 'all', onFilterChange }: {
  target?: PlaybackTarget; onClose(): void; embedded?: boolean; filter?: SubtitleTaskFilter; onFilterChange?(filter: SubtitleTaskFilter): void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<SubtitleTasksSnapshot>({ tasks: [], error: null })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [prepared, setPrepared] = useState<SubtitlePreparation | null>(null)
  const [view, setView] = useState<'files' | 'generate'>('files')
  const [audioIndex, setAudio] = useState(0)
  const [output, setOutput] = useState<'bilingual' | 'japanese'>('bilingual')
  const [busy, setBusy] = useState(false), [preparing, setPreparing] = useState(!!target)
  const [error, setError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<{ id: string; message: string } | null>(null)
  const mounted = useRef(true), sequence = useRef(0), locked = useRef(false)
  useEffect(() => {
    mounted.current = true
    let fetching = false
    const load = async (): Promise<void> => {
      if (fetching || locked.current) return
      fetching = true
      const request = sequence.current
      try { const value = await api.playback.subtitleTasks(); if (mounted.current && request === sequence.current) { setSnapshot(value); setLoadError(null) } }
      catch (cause) { if (mounted.current && request === sequence.current) setLoadError(cause instanceof Error ? cause.message : '读取任务失败') }
      finally { fetching = false; if (mounted.current) setLoading(false) }
    }
    void load(); const timer = setInterval(() => void load(), 2000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])
  const prepare = useCallback(async (): Promise<void> => {
    if (!target) return
    setPreparing(true); setPrepared(null); setError(null)
    try {
      const value = await api.playback.prepareSubtitles(target)
      if (mounted.current) { setPrepared(value); setAudio(value.audio[0]?.index ?? 0) }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '无法检查影片音轨，请检查模型运行环境') }
    finally { if (mounted.current) setPreparing(false) }
  }, [target])
  useEffect(() => { if (view === 'generate') void prepare() }, [prepare, view])
  async function execute(command: SubtitleTaskCommand): Promise<boolean> {
    if (locked.current) return false
    locked.current = true; sequence.current++; setBusy(true); setError(null); setCommandError(null)
    try {
      const value = await api.playback.subtitleTaskCommand(command)
      if (mounted.current) { setSnapshot(value); setLoadError(null) }
      return true
    } catch (cause) {
      if (mounted.current) {
        const message = cause instanceof Error ? cause.message : '字幕任务操作失败'
        if (command.action === 'enqueue') setError(message)
        else setCommandError({ id: command.id, message })
      }
      return false
    }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  const sourceTasks = snapshot.tasks.filter(job => !target || job.target.libraryId === target.libraryId && job.target.videoId === target.videoId && job.target.resourceId === target.resourceId)
  const tasks = sourceTasks.filter(job => matchesSubtitleFilter(job, filter))
  const content =
    <div className={styles.root}>
      {target && <div className={styles.managementTabs}>
        <SegmentedControl variant="subtle" aria-label="字幕管理分类">
          <SegmentedOption selected={view === 'files'} onClick={() => setView('files')}>字幕文件</SegmentedOption>
          <SegmentedOption selected={view === 'generate'} onClick={() => setView('generate')}>AI 生成</SegmentedOption>
        </SegmentedControl>
      </div>}
      {target && view === 'files' ? <SubtitleFilesPanel target={target} /> : <>
      {target && <section className={styles.preparation} aria-label="生成字幕">
        <div className={styles.preparationHead}>
          <p role="status">{preparing ? '正在检查影片' : prepared?.duration != null ? `时长 ${playbackTime(prepared.duration)}` : '请检查影片和模型运行环境后重试'}</p>
          <Button size="sm" disabled={preparing || busy} onClick={() => void prepare()}>刷新字幕与音轨</Button>
        </div>
        {prepared && <>
          {prepared.error && <p className={styles.error}>{prepared.error}</p>}
          <div className={styles.fields}><label className={styles.field}>识别音轨<SelectControl value={audioIndex} disabled={busy || preparing} onChange={event => setAudio(Number(event.target.value))}>
            {prepared.audio.map(audio => <option key={audio.index} value={audio.index}>{audio.label}</option>)}
          </SelectControl></label>
          <label className={styles.field}>生成内容<SelectControl value={output} disabled={busy} onChange={event => setOutput(event.target.value as typeof output)}>
            <option value="bilingual">日中双语</option><option value="japanese">仅日语</option>
          </SelectControl></label></div>
          <div className={styles.createAction}><Button size="sm" variant="primary" disabled={busy || preparing || prepared.duration == null || !prepared.audio.length} onClick={() => void execute({ action: 'enqueue', target, audioIndex, output })}>生成 AI 字幕</Button></div>
        </>}
      </section>}
      {error && <p className={styles.loadError} role="alert">{error}</p>}
      {embedded && onFilterChange && <div className={styles.toolbar}>
        <SegmentedControl variant="subtle" aria-label="筛选字幕任务">
          {filters.map(item => <SegmentedOption key={item.value} selected={filter === item.value} aria-label={item.accessible} onClick={() => onFilterChange(item.value)}>
            {item.label}<span className={styles.filterCount}>{loading ? '—' : sourceTasks.filter(job => matchesSubtitleFilter(job, item.value)).length}</span>
          </SegmentedOption>)}
        </SegmentedControl>
        <span className={styles.count}>{loading ? '读取中…' : `${tasks.length} 项任务`}</span>
      </div>}
      {(loadError || snapshot.error) && <p className={styles.loadError} role="alert">{loadError || snapshot.error}</p>}
      <div className={styles.list} aria-label="字幕任务列表">
        {tasks.length > 0 && <div className={styles.columns} aria-hidden="true"><span>影片</span><span>生成进度</span><span>状态</span><span>操作</span></div>}
        {loading && <EmptyState variant="compact" loading title="正在读取字幕任务…" />}
        {!loading && !loadError && !snapshot.error && !tasks.length && <EmptyState variant="compact" icon={<Captions size={24} />} title={filter === 'all' ? '暂无字幕任务' : '没有符合筛选条件的字幕任务'}
          description={filter === 'all' ? '在影片资源的「…」菜单中选择「字幕管理」，即可关联字幕或创建生成任务。' : '可切换其他分类查看任务。'} />}
        {tasks.map(job => <SubtitleTaskRow key={job.id} job={job} busy={busy} error={commandError?.id === job.id ? commandError.message : undefined} execute={execute} />)}
      </div>
      <p className={styles.footnote}><Info size={13} /><span>字幕默认保存到影片目录。关闭播放器后继续生成；退出应用会暂停，下次可手动继续。</span></p>
      </>}
    </div>
  return embedded ? content : <Modal title={target ? '字幕管理' : '字幕任务'} size="lg" layout="form" onCancel={onClose} hideActions>{content}</Modal>
}
