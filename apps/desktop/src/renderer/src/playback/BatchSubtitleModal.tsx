import { useEffect, useRef, useState } from 'react'
import { Captions, Check, CircleAlert, FileVideo, ListChecks, ListVideo } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { BatchSubtitleItem, BatchSubtitlePreview, BatchSubtitleResult, SubtitleOutput } from '@shared/desktop/subtitleTasks'
import { api } from '../api'
import Modal from '../components/Modal'
import Button from '../components/Button'
import SelectControl from '../components/SelectControl'
import { SegmentedControl, SegmentedOption } from '../components/SegmentedControl'
import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import { taskCenterPath } from '../tasks/taskCenterRoutes'
import { modelUsageLocation } from '../settings/settingsRoutes'
import styles from './BatchSubtitleModal.module.css'

interface Row extends BatchSubtitlePreview {
  audioIndex: number | null
  resumeId?: string
  replaceRevision?: string
}
type Group = 'choice' | 'ready' | 'existing' | 'skip'
type Filter = 'all' | Group
const filters: Record<Filter, string> = { all: '全部影片', ready: '可入队', choice: '待确认', existing: '已有字幕', skip: '将跳过' }
const pageSize = 24

function decision(row: Row, output: SubtitleOutput): { group: Group; reason: string; resume?: string } {
  if (row.error) return { group: 'skip', reason: row.error }
  if (row.resourceId === null) return { group: 'choice', reason: '请选择影片文件' }
  const file = row.existingFiles[output]
  if (file) {
    if (!file.revision) return { group: 'skip', reason: '同名位置不是可替换的普通文件' }
    if (row.jobs.some(job => job.output === output && ['queued', 'running', 'saving'].includes(job.status))) {
      return { group: 'skip', reason: '相同输出已有任务在队列中' }
    }
    if (row.replaceRevision !== file.revision) return { group: 'existing', reason: file.name }
  }
  if (row.audioIndex === null) return { group: 'choice', reason: '请选择日语音轨' }
  if (file) return { group: 'ready', reason: '生成后替换 ' + file.name }
  const job = row.jobs.find(item => item.output === output && item.audioIndex === row.audioIndex)
  if (!job) return { group: 'ready', reason: '新建任务' }
  if (job.status === 'paused' || job.status === 'failed') {
    return { group: row.resumeId === job.id ? 'ready' : 'choice', reason: job.status === 'paused' ? '已有暂停任务' : '已有失败任务', resume: job.id }
  }
  const reason = { queued: '已在队列中', running: '正在生成', saving: '正在保存', 'awaiting-save': '已生成，等待保存', completed: '已有完成记录' }[job.status]
  return { group: 'skip', reason }
}

function rowFilters(row: Row, output: SubtitleOutput): Filter[] {
  const { group } = decision(row, output)
  const matches: Filter[] = [group === 'existing' ? 'skip' : group]
  if (row.existingFiles[output]) matches.push('existing')
  return matches
}

const statusLabels = {
  ready: '可入队', choice: '待确认', existing: '保留原字幕', skip: '将跳过', replace: '将覆盖', resume: '将继续',
  queued: '已入队', resumed: '已继续', pending: '未提交', skipped: '已跳过', failed: '提交失败'
}
function Status({ kind }: { kind: keyof typeof statusLabels }): JSX.Element {
  return <span className={styles.status} data-kind={kind}>
    {['ready', 'queued', 'resume', 'resumed'].includes(kind) ? <Check size={12} /> : <i />}
    {statusLabels[kind]}
  </span>
}

const prepareRow = (preview: BatchSubtitlePreview): Row => ({ ...preview, audioIndex: preview.suggestedAudio })

export default function BatchSubtitleModal({ libraryId, videoIds, onClose }: {
  libraryId: number; videoIds: number[]; onClose(): void
}): JSX.Element {
  const navigate = useNavigate()
  const [output, setOutput] = useState<SubtitleOutput>('bilingual')
  const [rows, setRows] = useState<Row[]>([])
  const [context, setContext] = useState('')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [checked, setChecked] = useState(0)
  const [editing, setEditing] = useState(false)
  const [submitted, setSubmitted] = useState<number | null>(null)
  const [results, setResults] = useState<BatchSubtitleResult[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(pageSize)
  const filterBar = useRef<HTMLDivElement>(null)
  const resultHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { if (results) resultHeading.current?.focus() }, [results])
  const live = useRef(false)
  useEffect(() => {
    live.current = true
    let cancelled = false
    async function check(): Promise<void> {
      const token = await api.playback.batchSubtitleContext()
      const prepared: Row[] = []
      for (const id of videoIds) {
        if (cancelled) return
        prepared.push(prepareRow(await api.playback.batchSubtitlePreview(token, libraryId, id, null)))
        if (!cancelled) setChecked(prepared.length)
      }
      if (!cancelled) { setRows(prepared); setContext(token) }
    }
    void check().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)) })
    return () => { cancelled = true; live.current = false }
  }, [libraryId, videoIds, attempt])

  function update(id: number, change: Partial<Row>): void {
    // A row can leave the active filter as soon as its missing choice is made.
    const row = rows.find(item => item.videoId === id)
    if (row && filter !== 'all' && !rowFilters({ ...row, ...change }, output).includes(filter)) {
      filterBar.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
    }
    setRows(previous => previous.map(item => item.videoId === id ? { ...item, ...change } : item))
  }
  async function changeFile(id: number, resourceId: number): Promise<void> {
    setEditing(true)
    try {
      const preview = await api.playback.batchSubtitlePreview(context, libraryId, id, resourceId)
      if (live.current) update(id, { ...prepareRow(preview), error: preview.error, resumeId: undefined, replaceRevision: undefined })
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (live.current) setEditing(false) }
  }
  const groups: Record<Filter, Row[]> = { all: rows, ready: [], choice: [], existing: [], skip: [] }
  for (const row of rows) {
    for (const key of rowFilters(row, output)) groups[key].push(row)
  }
  const readyRows = groups.ready, visibleRows = groups[filter]
  const existing = groups.existing.filter(row => row.existingFiles[output]?.revision && decision(row, output).group !== 'skip')
  const replacements = readyRows.filter(row => row.existingFiles[output]).length
  const allReplacing = existing.length > 0 && existing.every(row => row.replaceRevision === row.existingFiles[output]?.revision)
  const pending = groups.choice.length
  function changeOutput(value: SubtitleOutput): void {
    if (value === output) return
    setOutput(value); setFilter('all'); setLimit(pageSize)
    setRows(previous => previous.map(row => ({ ...row, replaceRevision: undefined, resumeId: undefined })))
  }
  async function submit(): Promise<void> {
    const items: BatchSubtitleItem[] = readyRows.map(row => ({
      videoId: row.videoId, resourceId: row.resourceId!, audioIndex: row.audioIndex!, signature: row.signature,
      resumeId: decision(row, output).resume,
      replaceRevision: row.replaceRevision === row.existingFiles[output]?.revision ? row.replaceRevision : undefined
    }))
    const outcomes: BatchSubtitleResult[] = []
    setSubmitted(0)
    for (let i = 0; i < items.length && live.current; i += 16) {
      const chunk = items.slice(i, i + 16)
      try {
        outcomes.push(...await api.playback.batchSubtitleSubmit(context, libraryId, output, chunk))
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        outcomes.push(...chunk.map(item => ({ videoId: item.videoId, outcome: 'failed' as const, message })))
      }
      if (live.current) setSubmitted(outcomes.length)
    }
    if (live.current) { setLimit(pageSize); setResults(outcomes) }
  }
  const locked = editing || submitted !== null
  const taskCenter = () => { onClose(); navigate(taskCenterPath('subtitles')) }
  const resultByVideo = new Map(results?.map(item => [item.videoId, item]))
  const accepted = results?.filter(item => item.outcome === 'queued' || item.outcome === 'resumed').length ?? 0
  const failed = results?.filter(item => item.outcome === 'failed').length ?? 0
  function retry(): void {
    setContext(''); setError(''); setChecked(0); setRows([]); setFilter('all'); setLimit(pageSize); setAttempt(n => n + 1)
  }
  return createPortal(<Modal title="批量生成 AI 字幕" size="lg" layout="form" onCancel={onClose}
    subtitle={`${videoIds.length} 部影片`} className={styles.modal}
    confirmText={replacements ? `加入队列（${readyRows.length} 部，覆盖 ${replacements} 部）` : `加入队列（${readyRows.length}）`}
    confirmDisabled={!context || !!error || locked || !readyRows.length}
    onConfirm={submit} actions={results || error ? <>
      <Button onClick={onClose}>关闭</Button>
      {results ? <Button variant="primary" onClick={taskCenter}>查看字幕任务</Button> :
        <><Button onClick={() => { onClose(); navigate(modelUsageLocation('')) }}>字幕模型设置</Button>
          <Button variant="primary" onClick={retry}>重新检查</Button></>}
    </> : undefined}>
    {error ? <div className={styles.state} role="alert"><CircleAlert size={26} /><strong>无法完成检查</strong><span>{error}</span></div> :
      !context ? <div className={styles.state} role="status"><ListVideo size={28} /><strong>正在检查影片文件和音轨</strong>
        <progress max={Math.max(videoIds.length, 1)} value={checked} aria-label="影片检查进度" /><span>{checked} / {videoIds.length} 部</span>
      </div> : results ? <>
        <div className={styles.resultBanner} data-tone={failed ? 'warning' : accepted ? 'success' : 'neutral'}>
          {failed ? <CircleAlert size={22} /> : <ListChecks size={22} />}
          <div><h4 className={styles.resultHeading} ref={resultHeading} tabIndex={-1}>{accepted ? `${accepted} 部影片已加入字幕队列` : '本次没有影片加入队列'}</h4>
            <span className={styles.resultDetail}>{[failed > 0 && `${failed} 部提交失败`, pending > 0 && `${pending} 部待确认`,
              rows.length - accepted - failed - pending > 0 && `${rows.length - accepted - failed - pending} 部已跳过`]
              .filter(Boolean).join(' · ') || '可在字幕任务中查看生成进度'}</span></div>
        </div>
        <ul className={styles.list} aria-label="逐部提交结果">
          {rows.slice(0, limit).map(row => {
            const result = resultByVideo.get(row.videoId), state = decision(row, output)
            const outcome = result?.outcome ?? (state.group === 'choice' ? 'pending' : 'skipped')
            const selectedFile = row.resources.find(resource => resource.id === row.resourceId)?.name
            const detail = outcome === 'queued' || outcome === 'resumed'
              ? selectedFile
              : result?.message ?? (state.group === 'existing' ? '保留 ' + state.reason : state.reason)
            return <li className={styles.row} key={row.videoId}><div className={styles.identity}><strong>{row.code}</strong>
              {detail && <span className={styles.detail}>{detail}</span>}</div>
              <Status kind={outcome} /></li>
          })}
        </ul>
        {limit < rows.length && <Button size="sm" variant="ghost" onClick={() => setLimit(n => n + pageSize)}>显示更多影片</Button>}
      </> : <>
        <div className={styles.output}>
          <div className={styles.outputTitle}><Captions size={20} />
            <div className={styles.outputCopy}><strong>字幕内容</strong><span className={styles.destination}>保存到各影片所在目录</span></div>
          </div>
          <SegmentedControl aria-label="字幕内容" variant="subtle">
            <SegmentedOption selected={output === 'bilingual'} disabled={locked} onClick={() => changeOutput('bilingual')}>日中双语</SegmentedOption>
            <SegmentedOption selected={output === 'japanese'} disabled={locked} onClick={() => changeOutput('japanese')}>仅日语</SegmentedOption>
          </SegmentedControl>
        </div>
        <div className={styles.filters} role="group" aria-label="筛选影片" ref={filterBar}>
          {(Object.keys(filters) as Filter[]).map(key => <button className={styles.filter} key={key} type="button" aria-pressed={filter === key}
            onClick={() => { setFilter(key); setLimit(pageSize) }}>{filters[key]} <span>{groups[key].length}</span></button>)}
        </div>
        {existing.length > 1 && (filter === 'existing' || filter === 'all') && <div className={styles.bulk}>
          <span>{existing.length} 份已有字幕可覆盖</span>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => {
            const ids = new Set(existing.map(row => row.videoId))
            setRows(previous => previous.map(row => ids.has(row.videoId)
              ? { ...row, replaceRevision: allReplacing ? undefined : row.existingFiles[output]?.revision ?? undefined, resumeId: undefined } : row))
          }}>{allReplacing ? '取消全部覆盖' : '选择全部覆盖'}</Button>
        </div>}
        <ul className={styles.list} aria-label="影片处理清单">
          {visibleRows.slice(0, limit).map(row => {
            const state = decision(row, output), file = row.existingFiles[output]
            const available = row.resources.filter(resource => !resource.error)
            const name = row.resources.find(resource => resource.id === row.resourceId)?.name ?? row.resources[0]?.name
            const replace = !!file?.revision && row.replaceRevision === file.revision
            const kind = state.group === 'ready' ? replace ? 'replace' : state.resume ? 'resume' : 'ready' : state.group
            return <li key={row.videoId} className={styles.row} aria-label={row.code}>
              <div className={styles.identity}>
                <div className={styles.rowTitle}><strong>{row.code}</strong><Status kind={kind} /></div>
                {name && <span className={styles.filename} title={name}><FileVideo size={13} />{name}</span>}
                {file && <span className={styles.filename} title={file.name}><Captions size={13} />{file.name}</span>}
                {(state.group === 'skip' || state.resume) && <span className={styles.detail}>{state.reason}</span>}
              </div>
              <div className={styles.options}>
                {(available.length > 1 || (row.resourceId === null && available.length === 1)) && <SelectControl aria-label={row.code + ' 影片文件'}
                  value={row.resourceId ?? ''} disabled={locked} onChange={e => void changeFile(row.videoId, Number(e.target.value))}>
                  <option value="" disabled>选择影片文件</option>
                  {available.map(r => <option key={r.id} value={r.id}>{r.name}{r.primary ? ' · 主资源' : ''}</option>)}
                </SelectControl>}
                {file?.revision && state.group !== 'skip' && <label className={styles.check}>
                  <Checkbox aria-label={'覆盖并重新生成 ' + file.name} checked={replace} disabled={locked}
                    onChange={e => update(row.videoId, { replaceRevision: e.target.checked ? file.revision ?? undefined : undefined, resumeId: undefined })} />
                  覆盖并重新生成</label>}
                {row.audio.length > 1 && (!file || replace) && <SelectControl aria-label={row.code + ' 音轨'}
                  value={row.audioIndex ?? ''} disabled={locked} onChange={e => update(row.videoId, { audioIndex: Number(e.target.value), resumeId: undefined })}>
                  <option value="" disabled>选择日语音轨</option>
                  {row.audio.map(t => <option key={t.index} value={t.index}>{t.label}</option>)}
                </SelectControl>}
                {state.resume && <label className={styles.check}><Checkbox checked={row.resumeId === state.resume} disabled={locked}
                  onChange={e => update(row.videoId, { resumeId: e.target.checked ? state.resume : undefined })} />继续未完成部分</label>}
              </div>
            </li>
          })}
        </ul>
        {!visibleRows.length && <div className={styles.empty}>当前筛选下没有影片</div>}
        {visibleRows.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit(n => n + pageSize)}>显示更多影片（剩余 {visibleRows.length - limit} 部）</Button>}
        <div className={styles.notes}><span role="status">
          {submitted !== null ? `正在加入队列… ${submitted} / ${readyRows.length}` : editing ? '正在检查所选文件…' :
            filter !== 'all' ? `提交全部已就绪影片，共 ${readyRows.length} 部。` :
              pending > 0 ? `${pending} 部待确认，本次仅提交已就绪的影片。` : ''}
        </span>{rows.some(row => row.jobs.length > 0) && <Button size="sm" variant="ghost" disabled={locked} onClick={taskCenter}>查看已有字幕任务</Button>}</div>
      </>}
  </Modal>, document.body)
}
