import { useEffect, useMemo, useRef, useState } from 'react'
import { SearchX } from 'lucide-react'
import type { ActressPickerItem } from '@shared/actressTypes'
import { parseTestTargetList } from '@shared/pluginDevKindProfile'
import type { Video } from '@shared/videoTypes'
import { api, resolveMediaSrc } from '../../api'
import { ALL_CATALOG_SCOPE } from '../../query/catalogScopes'
import { useDebounce } from '../../hooks/useDebounce'
import Modal from '../Modal'
import Button from '../Button'
import ActressName from '../ActressName'
import ActressAvatar from '../ActressAvatar'
import EmptyState from '../EmptyState'
import { UI_ICON_SM } from '../iconDefaults'
import type { PluginKind } from './types'

interface Props {
  kind: PluginKind
  selectedValues: string[]
  onAdd: (value: string) => void
  onClose: () => void
}

const VIDEO_RESULT_LIMIT = 60
const ACTRESS_RESULT_LIMIT = 40

function normalizeTarget(value: string): string {
  return value.normalize('NFKC').trim().replace(/\p{White_Space}+/gu, ' ').toLowerCase()
}

function formatDate(value: string | null): string {
  if (!value) return '未发行'
  return value.slice(0, 10)
}

function titleForKind(kind: PluginKind): string {
  return kind === 'actress' ? '选择测试演员' : '选择测试番号'
}

export default function PluginDevMediaTargetPicker(props: Props): JSX.Element {
  return <TargetPickerSession key={props.kind} {...props} />
}

function TargetPickerSession({
  kind,
  selectedValues,
  onAdd,
  onClose
}: Props): JSX.Element {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 250)
  const [videos, setVideos] = useState<Video[]>([])
  const [videoTotal, setVideoTotal] = useState(0)
  const [actresses, setActresses] = useState<ActressPickerItem[]>([])
  const [loading, setLoading] = useState(true)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [resolvingSelection, setResolvingSelection] = useState(false)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [addingId, setAddingId] = useState<number | null>(null)
  const [resolvedNames, setResolvedNames] = useState<Record<number, string>>({})
  const choiceEpoch = useRef(0)
  const choiceBusy = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [error, setError] = useState<string | null>(null)
  const selectedSet = useMemo(
    () => new Set(selectedValues.map((value) => normalizeTarget(value))),
    [selectedValues]
  )

  const latestSelection = useRef(selectedSet)
  latestSelection.current = selectedSet
  const latestTargetCount = useRef(selectedValues.length)
  latestTargetCount.current = selectedValues.length
  const latestAdd = useRef(onAdd)
  latestAdd.current = onAdd
  const invalidateChoice = (): void => {
    choiceEpoch.current++
    choiceBusy.current = false
    setAddingId(null)
    setChoiceError(null)
  }
  const close = (): void => { choiceEpoch.current++; onClose() }
  const movePage = (nextOffset: number): void => {
    invalidateChoice(); setActresses([]); setHasMore(false); setLoading(true); setOffset(nextOffset)
  }
  const chooseActress = async (id: number): Promise<void> => {
    if (choiceBusy.current) return
    choiceBusy.current = true
    const epoch = ++choiceEpoch.current
    setAddingId(id); setChoiceError(null)
    try {
      const name = await api.actresses.testTargetGet(id)
      if (!mounted.current || epoch !== choiceEpoch.current) return
      if (name === null) throw new Error('该演员已不存在或不再符合候选条件，请刷新列表')
      const parsed = parseTestTargetList(name)
      if (parsed.length !== 1 || parsed[0] !== name) throw new Error('该演员名称包含目标分隔符，无法作为单个测试目标添加')
      if (!latestSelection.current.has(normalizeTarget(name)) && latestTargetCount.current >= 8) throw new Error('每次最多运行 8 个目标')
      setResolvedNames(current => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => Number(key) !== id).slice(-99)), [id]: name }))
      if (!latestSelection.current.has(normalizeTarget(name))) latestAdd.current(name)
    } catch (error) {
      if (mounted.current && epoch === choiceEpoch.current) setChoiceError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mounted.current && epoch === choiceEpoch.current) { choiceBusy.current = false; setAddingId(null) }
    }
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setActresses([]); setVideos([]); setHasMore(false)
    if (search !== debouncedSearch) return () => { cancelled = true }

    const load = async (): Promise<void> => {
      if (kind === 'actress') {
        const page = await api.actresses.testTargetPage({search: debouncedSearch.trim(),limit: ACTRESS_RESULT_LIMIT,offset})
        if (cancelled) return
        setActresses(page.items)
        setHasMore(page.hasMore)
        return
      }

      const result = await api.videos.list(ALL_CATALOG_SCOPE, {
        search: debouncedSearch.trim() || undefined,
        sortBy: 'add_time',
        sortDir: 'desc',
        limit: VIDEO_RESULT_LIMIT,
        offset: 0
      })
      if (cancelled) return
      setVideos(result.items)
      setVideoTotal(result.total)
      setActresses([])
    }

    void load()
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [debouncedSearch, search, kind, offset, retry])

  useEffect(() => {
    let cancelled = false
    const uncertain = selectedSet.size === 0 ? [] : actresses.filter(item => Array.from(item.main_name).length > 128)
    setSelectionError(null)
    setResolvingSelection(uncertain.length > 0)
    if (uncertain.length === 0) return
    let next = 0
    const resolved: Record<number, string> = {}
    let failed = false
    const worker = async (): Promise<void> => {
      while (!cancelled && next < uncertain.length) {
        const item = uncertain[next++]
        try { resolved[item.id] = await api.actresses.testTargetGet(item.id) ?? '' }
        catch { resolved[item.id] = ''; failed = true }
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, uncertain.length) }, worker)).then(() => {
      if (cancelled) return
      setResolvedNames(current => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !(key in resolved)).slice(-(100 - uncertain.length))), ...resolved }))
      setResolvingSelection(false)
      if (failed) setSelectionError('部分长名称的已选状态无法确认，请重试')
    })
    return () => { cancelled = true }
  }, [actresses, selectedSet])

  const resultCount = kind === 'actress' ? actresses.length : videos.length

  return (
    <Modal
      title={titleForKind(kind)}

      size="lg"
      className="modal--plugin-dev-target-picker"
      bodyOverflow="hidden"
      confirmText="完成"
      cancelText="关闭"
      onConfirm={close}
      onCancel={close}
    >
      <div className="plugin-dev-target-picker">
        <div className="plugin-dev-target-picker-head">
          <input
            className="text-input"
            value={search}
            aria-label="搜索测试目标"
            maxLength={kind === 'actress' ? 256 : undefined}
            placeholder={kind === 'actress' ? '搜索演员名或别名…' : '搜索番号、标题或演员…'}
            autoFocus
            onChange={(event) => { invalidateChoice(); setActresses([]); setVideos([]); setLoading(true); setOffset(0); setSearch(event.target.value) }}
          />
          <span className="plugin-dev-target-picker-count">
            {loading ? '加载中…' : kind === 'actress' ? `本页 ${resultCount} 名候选` : `${resultCount}/${videoTotal}`}
          </span>
        </div>

        {error ? <div className="plugin-dev-target-picker-error" role="alert">{error} <Button size="sm" onClick={() => { invalidateChoice(); setLoading(true); setRetry(value => value + 1) }}>重试</Button></div> : null}
        {selectionError ? <div className="plugin-dev-target-picker-error" role="alert">{selectionError} <Button size="sm" onClick={() => setRetry(value => value + 1)}>重试</Button></div> : null}
        {choiceError ? <div className="plugin-dev-target-picker-error" role="alert">{choiceError}</div> : null}

        <div className="plugin-dev-target-picker-list" role="list">
          {kind === 'actress'
            ? actresses.map((actress) => {
                const exactName = resolvedNames[actress.id] ?? (Array.from(actress.main_name).length <= 128 ? actress.main_name : '')
                const selected = exactName !== '' && selectedSet.has(normalizeTarget(exactName))
                return (
                  <button
                    key={actress.id}
                    type="button"
                    className={`plugin-dev-target-picker-row${selected ? ' is-selected' : ''}`}
                    disabled={selected || addingId !== null || resolvingSelection}
                    aria-label={`添加测试演员 ${actress.main_name}`}
                    onClick={() => void chooseActress(actress.id)}
                  >
                    <ActressAvatar
                      src={resolveMediaSrc(actress.avatar_path)}
                      name={actress.main_name}
                      gender="female"
                      className="plugin-dev-target-picker-avatar"
                      decorative
                    />
                    <span className="plugin-dev-target-picker-main">
                      <strong>
                        <ActressName name={actress.main_name} gender="female" />
                      </strong>

                    </span>
                    <span className="plugin-dev-target-picker-action">
                      {addingId === actress.id ? '读取中…' : resolvingSelection ? '核对中…' : selected ? '已添加' : '添加'}
                    </span>
                  </button>
                )
              })
            : videos.map((video) => {
                const selected = selectedSet.has(normalizeTarget(video.code))
                const poster = resolveMediaSrc(video.poster_path ?? video.cover_path)
                return (
                  <button
                    key={video.id}
                    type="button"
                    className={`plugin-dev-target-picker-row${selected ? ' is-selected' : ''}`}
                    disabled={selected}
                    onClick={() => onAdd(video.code)}
                  >
                    <span className="plugin-dev-target-picker-poster">
                      {poster ? <img src={poster} alt="" loading="lazy" /> : <span>{video.code}</span>}
                    </span>
                    <span className="plugin-dev-target-picker-main">
                      <strong>{video.code}</strong>
                      <small title={video.title ?? ''}>{video.title || '未命名影片'}</small>
                    </span>
                    <span className="plugin-dev-target-picker-meta">{formatDate(video.release_date)}</span>
                    <span className="plugin-dev-target-picker-action">
                      {selected ? '已添加' : '添加'}
                    </span>
                  </button>
                )
              })}
          {!loading && !error && resultCount === 0 ? (
            <EmptyState
              variant="modal"
              className="plugin-dev-target-picker-empty"
              icon={<SearchX {...UI_ICON_SM} aria-hidden />}
              title={search.trim() ? '没有找到匹配条目' : '媒体库暂无可选条目'}
              description={search.trim() ? '调整搜索关键词后再试。' : '导入媒体后可在这里选择测试目标。'}
            />
          ) : null}
        </div>
        {kind === 'actress' ? <div className="plugin-dev-target-picker-pagination" aria-label="测试演员分页">
          <Button size="sm" disabled={loading || offset === 0} onClick={() => movePage(Math.max(0, offset - ACTRESS_RESULT_LIMIT))}>上一页</Button>
          <span>第 {Math.floor(offset / ACTRESS_RESULT_LIMIT) + 1} 页</span>
          <Button size="sm" disabled={loading || !hasMore} onClick={() => movePage(offset + ACTRESS_RESULT_LIMIT)}>下一页</Button>
        </div> : null}
      </div>
    </Modal>
  )
}
