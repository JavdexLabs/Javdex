import { useEffect, useRef, useState } from 'react'
import { SearchX, UserRound } from 'lucide-react'
import {
  actressGenderMergeLabel
} from '@shared/actressProfileOptions'
import type { ActressGender, ActressMergeCandidate, ActressMergeMainNameFrom } from '@shared/actressTypes'
import type { ActressMetadata } from '@shared/actressTypes'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import ActressName from './ActressName'
import ActressAvatar from './ActressAvatar'
import Modal from './Modal'
import EmptyState from './EmptyState'
import { UI_ICON_SM } from './iconDefaults'
import Button from './Button'

interface Props {
  keepActress: Omit<ActressMetadata, 'gallery'> & ({ gallery: ActressMetadata['gallery'] } | { gallery_count: number })
  keepVideoCount: number
  onCancel: () => void
  onMerged: () => void
}

type MergeCardActress = {
  main_name: string
  gender: ActressGender | null
  avatar_path: string | null
  video_count: number
  gallery_count?: number
}

function MergeActressCard({
  actress,
  badge,
  empty = false,
  highlighted = false
}: {
  actress?: MergeCardActress
  badge: string
  empty?: boolean
  highlighted?: boolean
}): JSX.Element {
  const avatar = actress ? assetUrl(actress.avatar_path) : null

  return (
    <div
      className={`merge-actress-card${empty ? ' merge-actress-card--empty' : ''}${
        highlighted ? ' merge-actress-card--highlight' : ''
      }`}
    >
      <span className="merge-actress-card-badge">{badge}</span>
      {empty ? (
        <div className="merge-actress-card-avatar" aria-hidden="true">
          <span className="merge-actress-card-placeholder">
            <UserRound {...UI_ICON_SM} />
          </span>
        </div>
      ) : (
        <ActressAvatar
          src={avatar}
          name={actress?.main_name ?? ''}
          gender={actress?.gender}
          className="merge-actress-card-avatar"
          decorative
        />
      )}
      <div className="merge-actress-card-body">
        {empty ? (
          <>
            <div className="merge-actress-card-name merge-actress-card-name--muted">选择演员</div>
            <div className="merge-actress-card-meta">在下方列表中选择要并入的一名演员</div>
          </>
        ) : (
          actress && (
            <>
              <div className="merge-actress-card-name">
                <ActressName name={actress.main_name} gender={actress.gender} />
              </div>
              <div className="merge-actress-card-meta">
                {actress.video_count} 部影片
                {actress.gallery_count != null ? ` · ${actress.gallery_count} 张写真` : ''}
              </div>
            </>
          )
        )}
      </div>
    </div>
  )
}

export default function MergeActressModal(props: Props): JSX.Element {
  return <MergeActressSession key={`${props.keepActress.id}:${props.keepActress.gender ?? ''}`} {...props} />
}

function MergeActressSession({
  keepActress,
  keepVideoCount,
  onCancel,
  onMerged
}: Props): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const debouncedQ = useDebounce(searchInput, 300)
  const [items, setItems] = useState<ActressMergeCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<ActressMergeCandidate | null>(null)
  const [mainNameFrom, setMainNameFrom] = useState<ActressMergeMainNameFrom>('keep')
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const [pageError, setPageError] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [retry, setRetry] = useState(0)
  const mergeInFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])


  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setItems([])
    setHasMore(false)
    setPageError(null)
    if (searchInput !== debouncedQ) return () => { cancelled = true }
    void api.actresses.mergeCandidates({ keepId: keepActress.id, search: debouncedQ.trim(), limit: 40, offset })
      .then(page => {
        if (!cancelled) { setItems(page.items); setHasMore(page.hasMore) }
      })
      .catch(e => { if (!cancelled) setPageError(String((e as Error).message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [debouncedQ, searchInput, keepActress.id, offset, retry])

  const changePage = (nextOffset: number): void => {
    if (merging || loading) return
    setItems([]); setLoading(true); setPageError(null); setOffset(nextOffset)
  }

  const doMerge = async (): Promise<void> => {
    if (!selected || mergeInFlight.current) return
    mergeInFlight.current = true
    setMerging(true)
    setError(null)
    try {
      await api.actresses.merge({
        keepId: keepActress.id,
        mergeId: selected.id,
        mainNameFrom
      })
      if (mounted.current) onMerged()
    } catch (e) {
      if (mounted.current) setError(String((e as Error).message ?? e))
    } finally {
      mergeInFlight.current = false
      if (mounted.current) setMerging(false)
    }
  }

  const keepCard: MergeCardActress = {
    main_name: keepActress.main_name,
    gender: keepActress.gender ?? null,
    avatar_path: keepActress.avatar_path,
    video_count: keepVideoCount,
    gallery_count: 'gallery_count' in keepActress ? keepActress.gallery_count : keepActress.gallery.length
  }

  const selectedCard: MergeCardActress | undefined = selected
    ? {
        main_name: selected.main_name,
        gender: selected.gender ?? null,
        avatar_path: selected.avatar_path,
        video_count: selected.video_count
      }
    : undefined

  const finalMainName =
    selected == null
      ? keepActress.main_name
      : mainNameFrom === 'keep'
        ? keepActress.main_name
        : selected.main_name

  const demotedName =
    selected == null
      ? null
      : mainNameFrom === 'keep'
        ? selected.main_name
        : keepActress.main_name

  const mergedVideoCount =
    selected == null ? keepVideoCount : keepVideoCount + selected.video_count
  return (
    <Modal
      title="合并演员"
      hint={`将另一名${actressGenderMergeLabel(keepActress.gender)}资料并入当前条目。列表只显示可合并候选；影片与写真会保留，对方记录将被删除。`}

      size="md"
      className="merge-actress-modal"
      bodyOverflow="hidden"
      onCancel={onCancel}
      closeDisabled={merging}
      actions={
        <>
          <Button type="button" onClick={onCancel} disabled={merging}>
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={!selected || merging}
            onClick={() => void doMerge()}
          >
            {merging ? '合并中…' : '确认合并'}
          </Button>
        </>
      }
    >
      <div className="merge-actress-body">
        <div className="merge-actress-flow" aria-label="合并预览">
          <MergeActressCard actress={keepCard} badge="保留当前" highlighted />
          <div className="merge-actress-flow-arrow" aria-hidden="true">
            <span>并入当前</span>
          </div>
          <MergeActressCard
            actress={selectedCard}
            badge={selected ? '并入后删除' : '选择并入'}
            empty={!selected}
            highlighted={Boolean(selected)}
          />
        </div>

        <section className="merge-actress-section merge-actress-picker" aria-label="选择演员">
          <div className="merge-actress-section-head">
            <span className="merge-actress-section-title">选择要合并的演员</span>
            {!loading && items.length > 0 && (
              <span className="merge-actress-section-meta">本页 {items.length} 名候选</span>
            )}
          </div>
          <input
            className="search-input merge-actress-search"
            type="search"
            placeholder="搜索主名或别名…"
            aria-label="搜索合并候选"
            maxLength={256}
            disabled={merging}
            value={searchInput}
            onChange={(e) => { setItems([]); setLoading(true); setOffset(0); setSearchInput(e.target.value) }}
            autoFocus
          />

          <div className="merge-actress-pick-panel">
            {loading ? (
              <EmptyState variant="modal" loading />
            ) : pageError ? (
              <div role="alert" className="merge-actress-page-error">
                <p>合并候选读取失败</p>
                <Button size="sm" disabled={merging} onClick={() => setRetry(value => value + 1)}>重试</Button>
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                variant="modal"
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title={offset > 0 ? '本页没有候选演员' : debouncedQ.trim() ? '没有匹配的演员' : '没有可合并的候选演员'}
                description={
                  offset > 0 ? '返回上一页或调整搜索关键词。' : debouncedQ.trim()
                    ? '调整搜索关键词后再试。'
                    : '当前演员没有同组可合并候选。'
                }
              />
            ) : (
              <div className="merge-actress-pick-list" role="listbox" aria-label="演员列表">
                {items.map((item) => {
                  const isSelected = selected?.id === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-label={`选择合并演员 ${item.main_name}`}
                      aria-selected={isSelected}
                      className={`merge-actress-pick-item${isSelected ? ' is-selected' : ''}`}
                      disabled={merging}
                      onClick={() => { setSelected(isSelected ? null : item); setMainNameFrom('keep') }}
                    >
                      <span className="merge-actress-pick-radio" aria-hidden="true" />
                      <ActressAvatar
                        src={assetUrl(item.avatar_path)}
                        name={item.main_name}
                        gender={item.gender}
                        className="merge-actress-pick-avatar"
                        decorative
                      />
                      <span className="merge-actress-pick-main">
                        <span className="merge-actress-pick-name">
                          <ActressName name={item.main_name} gender={item.gender} />
                        </span>
                        <span className="merge-actress-pick-meta">{item.video_count} 部影片</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          <div className="merge-actress-pagination" aria-label="合并候选分页">
            <Button size="sm" disabled={merging || loading || offset === 0} onClick={() => changePage(Math.max(0, offset - 40))}>上一页</Button>
            <span aria-live="polite">第 {Math.floor(offset / 40) + 1} 页</span>
            <Button size="sm" disabled={merging || loading || !hasMore} onClick={() => changePage(offset + 40)}>下一页</Button>
          </div>
        </section>

        <section
          className={`merge-actress-section merge-actress-plan${
            selected ? '' : ' merge-actress-plan--empty'
          }`}
          aria-label="合并方案"
        >
          <div className="merge-actress-section-title">合并方案</div>
          {selected ? (
            <>
              <div className="merge-name-options">
                <label
                  className={`merge-name-option${mainNameFrom === 'keep' ? ' is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name="merge-main-name"
                    disabled={merging}
                    checked={mainNameFrom === 'keep'}
                    onChange={() => setMainNameFrom('keep')}
                  />
                  <span className="merge-name-option-copy">
                    <span className="merge-name-option-label">保留当前主名</span>
                    <span className="merge-name-option-value">{keepActress.main_name}</span>
                  </span>
                </label>
                <label
                  className={`merge-name-option${mainNameFrom === 'merge' ? ' is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name="merge-main-name"
                    disabled={merging}
                    checked={mainNameFrom === 'merge'}
                    onChange={() => setMainNameFrom('merge')}
                  />
                  <span className="merge-name-option-copy">
                    <span className="merge-name-option-label">使用对方主名</span>
                    <span className="merge-name-option-value">{selected.main_name}</span>
                  </span>
                </label>
              </div>

              <ul className="merge-actress-summary">
                <li>
                  当前条目保留为「{finalMainName}」，对方记录将删除
                </li>
                <li>
                  影片合并：{keepVideoCount} + {selected.video_count}，约{' '}
                  <strong>{mergedVideoCount}</strong> 部关联到保留条目
                </li>
                <li>写真与资料字段将合并到保留条目，已有字段优先保留</li>
                {demotedName && (
                  <li>
                    「{demotedName}」将写入别名
                  </li>
                )}
              </ul>
            </>
          ) : (
            <div className="merge-actress-plan-empty">
              先选择一名要并入的演员，再确认合并后的主名、影片数量和别名处理。
            </div>
          )}
        </section>

        {error && <p ref={errorRef} role="alert" className="merge-actress-error">{error}</p>}
      </div>
    </Modal>
  )
}
