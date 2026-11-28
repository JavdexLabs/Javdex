import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, ChevronUp, Info, Pencil, RotateCw, Trash2, X } from 'lucide-react'
import type { TranslationDraftRef, TranslationFieldView, TranslationTaskCommand, TranslationVideoView } from '@shared/desktop/metadataTranslationTasks'
import { discardableTranslationStatuses } from '@shared/desktop/metadataTranslationTasks'
import { STRING_FIELD_MAX } from '@shared/protocol/limits'
import Checkbox from '../../../../../../packages/ui/src/Checkbox'
import Button from '../components/Button'
import FloatingLayer from '../components/FloatingLayer'
import IconButton from '../components/IconButton'
import { SegmentedAction, SegmentedActions } from '../components/SegmentedActions'
import TextArea from '../components/TextArea'
import { translationFieldLabel, translationStatusLabel } from './translationTaskState'
import styles from './TranslationTasks.module.css'

export const selectable = (field: TranslationFieldView): boolean => discardableTranslationStatuses.includes(field.status)
export const draftRef = ({ id, revision, videoId }: TranslationDraftRef): TranslationDraftRef => ({ id, revision, videoId })
export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)
export type RunTranslationCommand = (command: TranslationTaskCommand) => Promise<void>

export interface TranslationEdit {
  item: TranslationDraftRef
  originalDraft: string
  value: string
}

function DraftEditor({ label, edit, stale, busy, disabled, onChange, onSave, onClose }: {
  label: string
  edit: TranslationEdit
  stale: boolean
  busy: boolean
  disabled: boolean
  onChange: (value: string) => void
  onSave: () => void
  onClose: () => void
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { area.current?.focus({ preventScroll: true }) }, [])
  const saveDisabled = disabled || stale || busy || !edit.value.trim() || edit.value.trim() === edit.originalDraft
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!saveDisabled) onSave()
    }
  }
  return <form className={styles.inlineEditor} onKeyDown={onKeyDown} onSubmit={event => event.preventDefault()}>
    <TextArea ref={area} className={styles.draftArea} aria-label={label} maxLength={STRING_FIELD_MAX} value={edit.value}
      readOnly={busy || stale || disabled} onChange={event => onChange(event.target.value)} />
    {stale && <p className={styles.error} role="status">译稿版本已变化，请取消后重新编辑。</p>}
    <div className={styles.editorActions}>
      <Button size="sm" className={styles.editorButton} variant="primary" disabled={saveDisabled} onClick={onSave} title="保存（Ctrl / ⌘ + Enter）">保存</Button>
      <Button size="sm" className={styles.editorButton} variant="ghost" disabled={busy} onClick={onClose} title="取消（Esc）">取消</Button>
    </div>
  </form>
}

interface ReviewActions {
  reviewing: boolean
  onApply: (item: TranslationDraftRef) => void
  onFilmCommand: (command: Extract<TranslationTaskCommand, { action: 'pause' | 'continue' | 'retry-apply' }>) => void
  onChangeModel: (film: TranslationVideoView) => void
  disabled: boolean
  writable: boolean
  checked: Set<string>
  edits: Map<string, TranslationEdit>
  run: RunTranslationCommand
  onToggle: (fields: TranslationFieldView[], checked: boolean) => void
  onEdit: (id: string, edit: TranslationEdit | null) => void
}

function FilmCell({ video, actions, compact = false }: { video: TranslationVideoView; actions: ReviewActions; compact?: boolean }): JSX.Element {
  const { disabled, writable } = actions
  const [infoOpen, setInfoOpen] = useState(false)
  const infoAnchor = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const infoId = useId()
  const available = video.fields.filter(field => selectable(field) && !actions.edits.has(field.id))
  const checkedCount = available.filter(field => actions.checked.has(field.id)).length
  const name = `${video.code} 任务信息`
  const code = <strong className={styles.filmCode}>{video.code}</strong>
  return <th scope={compact ? 'row' : 'rowgroup'} rowSpan={compact ? 1 : video.fields.length} className={`${styles.resultCell} ${styles.filmCell}`}>
    <div className={styles.filmIdentity}>
      {compact || !actions.reviewing ? code : <label className={styles.checkLabel}>
        <Checkbox checked={checkedCount > 0 && checkedCount === available.length}
          indeterminate={checkedCount > 0 && checkedCount < available.length} disabled={disabled || !available.length}
          aria-label={`选择 ${video.code} 的可处理字段`} onChange={event => actions.onToggle(available, event.target.checked)} />
        {code}
      </label>}
      <IconButton ref={infoAnchor} label={name} icon={<Info />} className={styles.infoButton} aria-haspopup="dialog"
        aria-expanded={infoOpen} aria-controls={infoOpen ? infoId : undefined} onClick={() => setInfoOpen(open => !open)} />
    </div>
    {infoOpen && <FloatingLayer open anchorRef={infoAnchor} initialFocusRef={closeButton} side="bottom" align="start"
      role="dialog" ariaLabel={name} id={infoId} className={styles.infoPanel} onClose={() => setInfoOpen(false)}>
      <div className={styles.infoHeading}>
        <strong>{video.code}</strong>
        <IconButton ref={closeButton} size="sm" label="关闭任务信息" icon={<X />} onClick={() => setInfoOpen(false)} />
      </div>
      <dl className={styles.filmInfo}>
        <dt>媒体库</dt><dd>{video.libraryName}</dd>
        <dt>翻译模型</dt><dd>{video.modelName}</dd>
        <dt>应用方式</dt><dd>{video.directApply ? '翻译后直接应用' : '预览后应用'}</dd>
        <dt>提交时间</dt><dd><time dateTime={video.createdAt}>{new Date(video.createdAt).toLocaleString()}</time></dd>
      </dl>
    </FloatingLayer>}
    {video.hasWork && <Button size="sm" variant="ghost" className={styles.filmAction}
      disabled={disabled || (video.paused && !writable)} aria-label={`${video.paused ? '继续' : '暂停'} ${video.code}`}
      onClick={() => actions.onFilmCommand({ action: video.paused ? 'continue' : 'pause', taskId: video.taskId, videoId: video.videoId })}>
      {video.paused ? '继续翻译' : '暂停翻译'}
    </Button>}
    {video.uncertain && <Button size="sm" variant="ghost" className={styles.filmAction} disabled={disabled || !writable}
      onClick={() => actions.onFilmCommand({ action: 'retry-apply', taskId: video.taskId, videoId: video.videoId })}>核对写入结果</Button>}
    {video.message && video.hasWork && <span className={styles.sourceNote}>{video.message}</span>}
    {video.paused && video.hasWork && <Button size="sm" variant="ghost" className={styles.filmAction}
      disabled={disabled || !writable || video.running} onClick={() => actions.onChangeModel(video)}>换模型继续</Button>}
  </th>
}

function StatusReason({ name, status, field }: { name: string; status: string; field: TranslationFieldView }): JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const heading = field.status === 'review' ? '重译未更新' : status
  const reasonLabel = `${name} · ${heading} · 查看原因`
  return <>
    <Button ref={trigger} size="sm" variant="ghost" className={styles.reasonButton} data-status={field.status}
      aria-label={reasonLabel} title="查看原因" aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} onClick={() => setOpen(value => !value)}>
      <Info size={13} aria-hidden="true" />{status}
    </Button>
    {field.status === 'review' && <span className={styles.reasonNote}>{heading}</span>}
    {open && <FloatingLayer open anchorRef={trigger} initialFocusRef={close} side="bottom" align="start"
      id={panelId} role="dialog" ariaLabel={reasonLabel} className={styles.infoPanel} onClose={() => setOpen(false)}>
      <div className={styles.infoHeading}>
        <strong>{heading}</strong>
        <IconButton ref={close} size="sm" label="关闭原因" icon={<X />} onClick={() => setOpen(false)} />
      </div>
      <p className={styles.reasonMessage}>{field.message}</p>
    </FloatingLayer>}
  </>
}

function FieldRow({ field, video, first, actions }: {
  field: TranslationFieldView; video: TranslationVideoView; first: boolean; actions: ReviewActions
}): JSX.Element {
  const { taskId } = video
  const { disabled, writable, checked, edits, run, onToggle, onEdit } = actions
  const edit = edits.get(field.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const textId = useId()
  const originalText = useRef<HTMLParagraphElement>(null)
  const translatedText = useRef<HTMLParagraphElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const restoreFocus = useRef(false)
  const label = translationFieldLabel[field.field]
  const name = `${video.code} ${label}`
  const summary = field.field === 'summary'
  const conflict = field.status === 'conflict' || field.previousStatus === 'conflict'
  const original = conflict && field.currentOriginal !== undefined ? field.currentOriginal : field.original
  const editable = field.translation !== null && ['review', 'blocked', 'conflict'].includes(field.status)
  const canApply = (field.status === 'review' || field.status === 'blocked') && !!field.translation && field.original !== null
  const applyLabel = field.status === 'blocked' ? '重试应用' : '应用'
  const retranslating = field.previousStatus !== null && (field.status === 'running' || field.status === 'queued')
  const status = video.paused && field.status === 'queued' ? '已暂停' : retranslating ? (field.status === 'running' ? '重译中' : '等待重译') : translationStatusLabel[field.status]
  const editing = Boolean(edit)
  useEffect(() => {
    if (!summary || expanded) return
    const elements = [originalText.current, translatedText.current].filter(node => node !== null)
    const check = (): void => setTruncated(elements.some(node => node.scrollHeight > node.clientHeight + 1))
    check()
    const observer = new ResizeObserver(check)
    for (const node of elements) observer.observe(node)
    return () => observer.disconnect()
  }, [summary, expanded, editing, original, field.translation])
  useEffect(() => {
    if (!editing && restoreFocus.current) {
      restoreFocus.current = false
      editButton.current?.focus({ preventScroll: true })
    }
  }, [editing, busy])

  function closeEdit(): void {
    restoreFocus.current = true
    setError('')
    onEdit(field.id, null)
  }
  async function act(command: TranslationTaskCommand): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await run(command)
      onToggle([field], false)
      if (command.action === 'edit') closeEdit()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  const item = draftRef(field)
  const textClass = `${styles.comparisonText} ${summary ? (expanded ? '' : styles.clamp) : styles.titleText}`
  const fullTextToggle = summary && (expanded || truncated) && <Button size="sm" variant="ghost" className={styles.expandAction}
    aria-expanded={expanded} aria-controls={editing ? `${textId}-source` : `${textId}-source ${textId}-draft`}
    onClick={() => setExpanded(value => !value)}>
    {expanded ? '收起全文' : '展开全文'}{expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
  </Button>
  const reason = field.message === '原文为空' && original === '' ? null : field.message
  const shortReason = field.status === 'skipped' && reason === '译文与原文相同' ? '与原文相同' : null
  const cell = styles.resultCell
  return <tr className={styles.resultRow} data-field={field.field} data-selected={checked.has(field.id) || undefined} aria-label={name}>
    {first && <FilmCell video={video} actions={actions} />}
    <th scope="row" className={`${cell} ${styles.fieldCell}`}>
      <label className={styles.checkLabel}>
        {actions.reviewing && <Checkbox checked={checked.has(field.id)} disabled={disabled || busy || editing || !selectable(field)}
          aria-label={`选择 ${name}`} onChange={event => onToggle([field], event.target.checked)} />}
        <span>{label}</span>
      </label>
    </th>
    <td className={`${cell} ${styles.sourceCell}`}>
      {conflict && <span className={styles.sourceNote}>
        {field.currentOriginal === undefined ? '当前原文暂不可读 · 以下为翻译时原文' : '当前原文'}
      </span>}
      <p id={`${textId}-source`} ref={originalText} className={textClass} data-empty={!original || undefined}>
        {original || (original === '' || conflict && field.currentOriginal === null ? '原文为空' : '—')}
      </p>
      {fullTextToggle}
    </td>
    <td className={`${cell} ${styles.draftCell}`}>
      {conflict && field.translation !== null && <span className={styles.sourceNote}>基于旧原文</span>}
      {edit ? <DraftEditor label={`${name}译文`} edit={edit} busy={busy}
        stale={edit.item.revision !== field.revision || !editable} disabled={disabled}
        onChange={value => onEdit(field.id, { ...edit, value })}
        onSave={() => void act({ action: 'edit', taskId, item: edit.item, translation: edit.value.trim() })}
        onClose={closeEdit} />
        : <>
          <p id={`${textId}-draft`} ref={translatedText} className={textClass} data-empty={!field.translation || undefined}>
            {field.translation ?? '—'}
          </p>
          {fullTextToggle}
        </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </td>
    <td className={`${cell} ${styles.statusCell}`}>
      {reason && !shortReason ? <StatusReason name={name} status={status} field={field} /> : <>
        <span className={styles.fieldStatus} data-status={field.status}>{status}</span>
        {shortReason && <span className={styles.reasonNote}>{shortReason}</span>}
      </>}
    </td>
    {actions.reviewing && <td className={`${cell} ${styles.actionCell}`}>
      <div className={styles.fieldActions}>
        {(editable || field.status === 'failed' || retranslating) && <SegmentedActions aria-label={`${name}译文操作`}>
          {canApply && <SegmentedAction className={`${styles.command} ${styles.applyCommand}`}
            aria-label={`${applyLabel} ${name}译文`} title={`${applyLabel} ${name}译文`}
            disabled={disabled || busy || editing || !writable} onClick={() => actions.onApply(item)}>
            <Check size={14} aria-hidden="true" /><span className={styles.commandText}>{applyLabel}</span>
          </SegmentedAction>}
          {(editable || retranslating) && <SegmentedAction ref={editButton} className={styles.command}
            aria-label="编辑" title={`编辑${name}`} disabled={disabled || busy || editing || !editable}
            onClick={() => {
              if (field.translation === null) return
              setError('')
              onEdit(field.id, { item, value: field.translation, originalDraft: field.translation })
            }}><Pencil size={14} /><span className={styles.commandText}>编辑</span></SegmentedAction>}
          <SegmentedAction className={styles.command} aria-label={field.status === 'failed' ? '重试翻译' : '重译'}
            title={`${field.status === 'failed' ? '重试翻译' : '重译'}${name}`}
            disabled={disabled || busy || editing || retranslating || !writable}
            onClick={() => void act({ action: editable ? 'retranslate' : 'retry', taskId, item })}>
            <RotateCw size={14} /><span className={styles.commandText}>{field.status === 'failed' ? '重试' : '重译'}</span>
          </SegmentedAction>
        </SegmentedActions>}
        {(selectable(field) || retranslating) &&
          <IconButton size="control" className={styles.discard} label="丢弃" title={`丢弃${name}译稿`}
            icon={<Trash2 />} disabled={disabled || busy || editing || retranslating}
            onClick={() => void act({ action: 'discard', taskId, item })} />}
      </div>
    </td>}
  </tr>
}

export default function TranslationReviewTable({ videos, selectableCount, selectedCount, onSelectAll, ...actions }: ReviewActions & {
  videos: TranslationVideoView[]
  selectableCount: number
  selectedCount: number
  onSelectAll: (checked: boolean) => void
}): JSX.Element {
  return <table className={styles.results} aria-label="影片翻译结果">
    <thead className={styles.resultsHeading}>
      <tr>
        <th scope="col" className={`${styles.cell} ${styles.filmCell}`}>
          <label className={styles.checkLabel}>
            {actions.reviewing && <Checkbox aria-label="全选可处理字段" checked={selectedCount > 0 && selectedCount >= selectableCount}
              indeterminate={selectedCount > 0 && selectedCount < selectableCount}
              disabled={actions.disabled || (!selectableCount && !selectedCount)}
              onChange={event => onSelectAll(event.target.checked)} />}
            <span>番号</span>
          </label>
        </th>
        <th scope="col" className={`${styles.cell} ${styles.fieldCell}`}>字段</th>
        <th scope="col" className={styles.cell}>原文</th>
        <th scope="col" className={styles.cell}>简体中文译文</th>
        <th scope="col" className={`${styles.cell} ${styles.statusCell}`}>状态</th>
        {actions.reviewing && <th scope="col" className={`${styles.cell} ${styles.actionCell}`}>操作</th>}
      </tr>
    </thead>
    {videos.map(video => {
      const compact = video.fields.every(field => (field.status === 'skipped' || field.status === 'discarded') && !field.original?.trim() && !field.translation)
      return <tbody key={`${video.taskId}:${video.videoId}`} className={styles.resultGroup}>
        {compact ? <tr className={`${styles.resultRow} ${styles.compactRow}`} aria-label={video.code}>
          <FilmCell video={video} actions={actions} compact />
          <td colSpan={actions.reviewing ? 5 : 4} className={styles.resultCell}>
            <ul className={styles.outcomes}>{video.fields.map(field => <li key={field.id} className={styles.outcome}>
              <span className={styles.outcomeLabel}>{translationFieldLabel[field.field]}</span>
              <span>{translationStatusLabel[field.status]}{field.message && ` · ${field.message}`}</span>
            </li>)}</ul>
          </td>
        </tr> : video.fields.map((field, index) => <FieldRow key={field.id} video={video} field={field} first={index === 0} actions={actions} />)}
      </tbody>
    })}
  </table>
}
