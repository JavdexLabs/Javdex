import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Check, Eraser, Pause, Play, Trash2 } from 'lucide-react'
import { TRANSLATION_PAGE_SIZE, type TranslationBulkOperation, type TranslationFilmRef, type TranslationVideoView, type TranslationDraftRef, type TranslationFieldSelection, type TranslationFieldView, type TranslationReviewFilter } from '@shared/desktop/metadataTranslationTasks'
import { api } from '../api'
import Button from '../components/Button'
import ConfirmModal from '../components/ConfirmModal'
import EmptyState from '../components/EmptyState'
import ListPagination from '../components/ListPagination'
import Modal from '../components/Modal'
import ScrollViewport from '../components/ScrollViewport'
import { SegmentedControl, SegmentedOption } from '../components/SegmentedControl'
import { useToast } from '../components/Toast'
import { useDesktopSession } from '../desktop/DesktopSessionContext'
import { modelUsageLocation } from '../settings/settingsRoutes'
import TranslationReviewTable, { draftRef, errorMessage, selectable, type RunTranslationCommand, type TranslationEdit } from './TranslationReviewTable'
import { TRANSLATION_TASKS_KEY, translationModelLocation } from './translationTaskState'
import styles from './TranslationTasks.module.css'

const reviewFilters: ReadonlyArray<readonly [TranslationReviewFilter, string]> = [
  ['active', '进行中 / 暂停'], ['attention', '需处理'], ['finished', '已完成']
]
const emptyTitles = { active: '暂无进行中或已暂停的翻译任务', attention: '暂无需要处理的翻译任务', finished: '暂无已完成的翻译任务' }
const bulkActions = {
  resume: { label: '全部开始', icon: Play }, pause: { label: '全部暂停', icon: Pause },
  'remove-active': { label: '全部移除', icon: Trash2 }, 'clear-completed': { label: '清空全部记录', icon: Eraser }
}
const bulkByFilter: Record<TranslationReviewFilter, TranslationBulkOperation[]> = {
  active: ['resume', 'pause', 'remove-active'], attention: [], finished: ['clear-completed']
}

function ChangeModel({ film, onClose, run }: { film: TranslationVideoView; onClose: () => void; run: RunTranslationCommand }): JSX.Element {
  const model = useQuery({ queryKey: ['metadata-translation-model'], queryFn: () => api.metadataTranslation.model(), retry: false })
  return createPortal(<Modal title={`更换 ${film.code} 的翻译模型`} size="sm" onCancel={onClose} confirmText="确认并继续"
    confirmDisabled={!model.data || model.isError || model.isFetching}
    onConfirm={async () => {
      if (!model.data) return
      await run({ action: 'change-model', taskId: film.taskId, videoId: film.videoId, modelToken: model.data.token })
      onClose()
    }}>
    <p>未生成的字段将使用当前文本翻译设置。</p>
    {model.isError ? <p role="alert" className={styles.error}>{model.error.message}</p> : model.data
      ? <p><strong>{model.data.name}</strong> · {translationModelLocation[model.data.location]}</p>
      : <p role="status">正在读取模型…</p>}
    {model.data?.location === 'cloud' && <p>未生成字段的原文会发送到该云端服务。</p>}
    <Link draggable={false} to={modelUsageLocation('', 'text-translation')} onClick={onClose}>翻译模型设置</Link>
  </Modal>, document.body)
}

export default function TranslationTasks({ filter, onFilterChange }: {
  filter: TranslationReviewFilter; onFilterChange: (filter: TranslationReviewFilter) => void
}): JSX.Element {
  const queryClient = useQueryClient()
  const { capabilities, session, catalogReadsEnabled } = useDesktopSession()
  const toast = useToast()
  const writable = capabilities.editCatalog.allowed
  const [position, setPosition] = useState({ filter, page: 1 })
  const page = position.filter === filter ? position.page : 1
  const [confirm, setConfirm] = useState<{ operation: 'remove-active' | 'clear-completed'; films: TranslationFilmRef[] } | null>(null)
  const [discardSnapshot, setDiscardSnapshot] = useState<TranslationDraftRef[] | null>(null)
  const resultsViewport = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(() => new Map<string, TranslationFieldSelection>())
  const [edits, setEdits] = useState(() => new Map<string, TranslationEdit>())
  const [pending, setPending] = useState(() => new Set<string>())
  const [modelDialog, setModelDialog] = useState<TranslationVideoView | null>(null)
  const [busy, setBusy] = useState(false)
  const query = useQuery({
    queryKey: [...TRANSLATION_TASKS_KEY, session.catalogId, session.serverId, session.generation, 'page', filter, page],
    queryFn: () => api.metadataTranslation.page((page - 1) * TRANSLATION_PAGE_SIZE, filter),
    refetchInterval: 1800, gcTime: 0, enabled: catalogReadsEnabled
  })
  const total = query.data?.total
  useEffect(() => {
    if (total !== undefined && page > Math.max(1, Math.ceil(total / TRANSLATION_PAGE_SIZE))) {
      setPosition({ filter, page: Math.max(1, Math.ceil(total / TRANSLATION_PAGE_SIZE)) })
    }
  }, [filter, page, total])
  const currentFields = useMemo(() => new Map(query.data?.items.flatMap(video => video.fields.map(field => [field.id, field] as const)) ?? []), [query.data])
  useEffect(() => {
    setSelected(previous => {
      const stale = [...previous.values()].filter(ref => {
        const field = currentFields.get(ref.id)
        return field && (field.revision > ref.revision || field.revision === ref.revision && !selectable(field))
      })
      if (!stale.length) return previous
      const next = new Map(previous)
      for (const ref of stale) next.delete(ref.id)
      return next
    })
  }, [currentFields])
  const selectedNow = [...selected.values()].filter(ref => {
    if (edits.has(ref.id) || pending.has(ref.id)) return false
    const field = currentFields.get(ref.id)
    return !field || (selectable(field) && field.revision === ref.revision)
  })
  const checked = new Set(selectedNow.map(ref => ref.id))
  const applicable = selectedNow.filter(ref => ref.status === 'review')
  const unavailable = [...new Set([...edits.keys(), ...pending])].filter(id => {
    const field = currentFields.get(id)
    return !field || selectable(field)
  })
  const selectableCount = Math.max(0, (query.data?.selectableFields ?? 0) - unavailable.length)
  const reviewing = filter === 'attention'

  const run: RunTranslationCommand = async command => {
    const id = 'item' in command ? command.item.id : null
    if (id) setPending(previous => new Set(previous).add(id))
    try {
      await api.metadataTranslation.command(command)
      await queryClient.invalidateQueries({ queryKey: TRANSLATION_TASKS_KEY })
    } finally {
      if (id) setPending(previous => {
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
  }
  async function handle(operation: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try { await operation() } catch (error) { toast.show(errorMessage(error), 'error') } finally { setBusy(false) }
  }
  function toggle(fields: TranslationFieldView[], select: boolean): void {
    setSelected(previous => {
      const next = new Map(previous)
      for (const field of fields) {
        if (select && !pending.has(field.id) && !edits.has(field.id)) next.set(field.id, { ...draftRef(field), status: field.status })
        else next.delete(field.id)
      }
      return next
    })
  }
  function onEdit(id: string, edit: TranslationEdit | null): void {
    setEdits(previous => {
      const next = new Map(previous)
      if (edit) next.set(id, edit)
      else next.delete(id)
      return next
    })
  }
  function onPageChange(next: number): void {
    setPosition({ filter, page: next })
    resultsViewport.current?.scrollTo({ top: 0 })
  }
  function changeFilter(next: TranslationReviewFilter): void {
    if (next === filter) return
    setPosition({ filter: next, page: 1 })
    onFilterChange(next)
  }
  function onSelectAll(select: boolean): void {
    if (!select) { setSelected(new Map()); return }
    void handle(async () => {
      const all = await api.metadataTranslation.selection()
      setSelected(new Map(all.filter(ref => !edits.has(ref.id) && !pending.has(ref.id)).map(ref => [ref.id, ref])))
    })
  }
  async function submitSelection(action: 'apply' | 'discard-selected', items: TranslationDraftRef[]): Promise<void> {
    try {
      await run({ action, items })
    } catch (error) {
      // Polling only covers the visible page. Drop stale selections from other pages as well.
      const fresh = await api.metadataTranslation.selection().catch(() => null)
      if (fresh) {
        const revisions = new Map(fresh.map(ref => [ref.id, ref.revision]))
        setSelected(previous => new Map([...previous].filter(([id, ref]) => revisions.get(id) === ref.revision)))
      }
      throw error
    }
    setSelected(previous => {
      const next = new Map(previous)
      for (const item of items) if (next.get(item.id)?.revision === item.revision) next.delete(item.id)
      return next
    })
  }
  async function startBulk(operation: TranslationBulkOperation): Promise<void> {
    const films = await api.metadataTranslation.bulkTargets(operation)
    if (!films.length) {
      await queryClient.invalidateQueries({ queryKey: TRANSLATION_TASKS_KEY })
      return
    }
    if (operation === 'remove-active' || operation === 'clear-completed') setConfirm({ operation, films })
    else await run({ action: 'bulk', operation, films })
  }
  return <div className={styles.detail}>
    <div className={styles.reviewBar}>
      <SegmentedControl variant="subtle" className={styles.reviewFilters} aria-label="筛选翻译任务">
        {reviewFilters.map(([value, label]) => <SegmentedOption key={value} selected={filter === value}
          disabled={busy} onClick={() => changeFilter(value)}>
          {label}<span className={styles.filterCount}>{query.data?.counts[value] ?? '—'}</span>
        </SegmentedOption>)}
      </SegmentedControl>
      {reviewing ? <div role="group" className={styles.bulkActions} aria-label="所选译稿操作">
        <span className={styles.selectionSummary} role="status" aria-atomic="true">
          <span>已选 <strong className={styles.selectionCount}>{selectedNow.length}</strong> 项</span>
          {selectedNow.length > 0 && !writable ? <small className={styles.selectionHint}>资料库只读</small>
            : applicable.length < selectedNow.length && <small className={styles.selectionHint}>{applicable.length ? `${applicable.length} 项可应用` : '均不可应用'}</small>}
        </span>
        <Button size="sm" variant="ghost" className={styles.applySelection} disabled={busy || !writable || !applicable.length}
          onClick={() => void handle(() => submitSelection('apply', applicable.map(draftRef)))}>
          <Check size={14} aria-hidden="true" />应用所选
        </Button>
        <Button size="sm" variant="ghost" className={styles.discardSelection} disabled={busy || !selectedNow.length}
          onClick={() => setDiscardSnapshot(selectedNow.map(draftRef))}>
          <Trash2 size={14} aria-hidden="true" />丢弃所选
        </Button>
      </div> : <div role="group" className={styles.bulkActions} aria-label="翻译任务快捷操作">
        {bulkByFilter[filter].map(operation => {
          const { icon: Icon, label } = bulkActions[operation]
          return <Button size="sm" variant="ghost" key={operation} disabled={busy || query.isError || !query.data?.bulkCounts[operation] || (operation === 'resume' && !writable)}
            onClick={() => void handle(() => startBulk(operation))}><Icon size={14} aria-hidden="true" />{label}</Button>
        })}
      </div>}
    </div>
    <ScrollViewport key={filter} ref={resultsViewport} variant="scroll" className={styles.resultsViewport} role="region" aria-label="译文审阅列表" tabIndex={0}>
      {query.isError && <p role="alert" className={styles.error}>{errorMessage(query.error)}</p>}
      {query.isPending && <p role="status" className={styles.muted}>正在读取译文…</p>}
      {query.data && (query.data.items.length > 0 ? <>
        <TranslationReviewTable videos={query.data.items} reviewing={reviewing} selectableCount={selectableCount} selectedCount={selectedNow.length}
          checked={checked} edits={edits} disabled={busy} writable={writable} run={run}
          onApply={item => void handle(() => submitSelection('apply', [item]))}
          onFilmCommand={command => void handle(() => run(command))} onChangeModel={setModelDialog}
          onSelectAll={onSelectAll} onToggle={toggle} onEdit={onEdit} />
        {query.data.total > TRANSLATION_PAGE_SIZE && <ListPagination label="翻译结果分页" page={page} pageSize={TRANSLATION_PAGE_SIZE}
          total={query.data.total} onPageChange={onPageChange} />}
      </> : <EmptyState title={emptyTitles[filter]}>
        {filter === 'active' && !query.data.counts.attention && !query.data.counts.finished && '在媒体库多选影片后，点击「翻译元数据」。'}
        {filter === 'active' && query.data.counts.attention > 0 &&
          <Button size="sm" onClick={() => changeFilter('attention')}>查看需处理任务</Button>}
        {filter === 'active' && !query.data.counts.attention && query.data.counts.finished > 0 &&
          <Button size="sm" onClick={() => changeFilter('finished')}>查看已完成记录</Button>}
      </EmptyState>)}
    </ScrollViewport>
    {modelDialog && <ChangeModel film={modelDialog} onClose={() => setModelDialog(null)} run={run} />}
    {discardSnapshot && createPortal(<ConfirmModal danger title="丢弃所选字段？" confirmText="确认丢弃" cancelText="返回"
      onCancel={() => setDiscardSnapshot(null)} onConfirm={() => {
        setDiscardSnapshot(null)
        void handle(() => submitSelection('discard-selected', discardSnapshot))
      }}>
      涉及 {new Set(discardSnapshot.map(ref => ref.videoId)).size} 部影片，共 {discardSnapshot.length} 个字段。确认后将清除这些字段的本机译稿，保留媒体库中的标题和简介。
    </ConfirmModal>, document.body)}
    {confirm && createPortal(<ConfirmModal danger title={confirm.operation === 'remove-active' ? '移除翻译任务？' : '清空已完成的翻译记录？'}
      confirmText={confirm.operation === 'remove-active' ? '确认移除任务' : '确认清空记录'} cancelText="返回"
      busy={busy} confirmDisabled={busy} onCancel={() => setConfirm(null)}
      onConfirm={() => void handle(async () => { await run({ action: 'bulk', ...confirm }); setConfirm(null) })}>
      {confirm.operation === 'remove-active'
        ? `将移除这 ${confirm.films.length} 项任务的进度和未应用译稿。已经写入媒体库的译文会保留。`
        : `将清理这 ${confirm.films.length} 项任务的本机记录。已经写入媒体库的译文会保留。`}
    </ConfirmModal>, document.body)}
  </div>
}
