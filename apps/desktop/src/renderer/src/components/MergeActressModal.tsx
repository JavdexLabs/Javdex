import ContinuousGrid from './ContinuousGrid'
import { useContinuousPage } from '../hooks/useContinuousPage'
import { useEffect, useRef, useState } from 'react'
import { SearchX, UserRound } from 'lucide-react'
import {
  actressGenderMergeLabel
} from '@shared/actressProfileOptions'
import type { ActressGender, ActressMergeCandidate, ActressMergeMainNameFrom } from '@shared/actressTypes'
import type { ActressMetadata } from '@shared/actressTypes'
import { api, assetUrl } from '../api'
import { expectedActressVersion } from '@shared/protocol/versions'
import { useDebounce } from '../hooks/useDebounce'
import ActressName from './ActressName'
import ActressAvatar from './ActressAvatar'
import Modal from './Modal'
import EmptyState from './EmptyState'
import { UI_ICON_SM } from './iconDefaults'
import Button from './Button'
import SearchInput from './SearchInput'
import styles from './MergeActressModal.module.css'

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
      className={styles.card}
      data-empty={empty}
      data-highlighted={highlighted}
    >
      <span className={styles.cardBadge}>{badge}</span>
      {empty ? (
        <div className={styles.cardAvatar} aria-hidden="true">
          <span className={styles.cardPlaceholder}>
            <UserRound {...UI_ICON_SM} />
          </span>
        </div>
      ) : (
        <ActressAvatar
          src={avatar}
          name={actress?.main_name ?? ''}
          gender={actress?.gender}
          className={styles.cardAvatar}
          decorative
        />
      )}
      <div className={styles.cardBody}>
        {empty ? (
          <>
            <div className={styles.cardName} data-muted>选择演员</div>
            <div className={styles.cardMeta}>在下方列表中选择要并入的一名演员</div>
          </>
        ) : (
          actress && (
            <>
              <div className={styles.cardName}>
                <ActressName name={actress.main_name} gender={actress.gender} />
              </div>
              <div className={styles.cardMeta}>
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
  const [selected, setSelected] = useState<ActressMergeCandidate | null>(null)
  const [mainNameFrom, setMainNameFrom] = useState<ActressMergeMainNameFrom>('keep')
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({ block: 'nearest' }) }, [error])
  const candidates = useContinuousPage(`merge:${keepActress.id}:${debouncedQ}`, 40,
    offset => api.actresses.mergeCandidates({ keepId: keepActress.id, search: debouncedQ.trim(), limit: 40, offset }))
  const { items, loading, error: pageError } = candidates
  const mergeInFlight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])


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
      }, expectedActressVersion(keepActress))
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
      className={styles.modal}
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
      <div className={styles.body}>
        <div className={styles.flow} data-merge-actress-part="flow" aria-label="合并预览">
          <MergeActressCard actress={keepCard} badge="保留当前" highlighted />
          <div className={styles.flowArrow} aria-hidden="true">
            <span>并入当前</span>
          </div>
          <MergeActressCard
            actress={selectedCard}
            badge={selected ? '并入后删除' : '选择并入'}
            empty={!selected}
            highlighted={Boolean(selected)}
          />
        </div>

        <section className={`${styles.section} ${styles.picker}`} data-merge-actress-part="picker" aria-label="选择演员">
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>选择要合并的演员</span>
            {!loading && items.length > 0 && (
              <span className={styles.sectionMeta}>可按名称搜索</span>
            )}
          </div>
          <SearchInput
            fullWidth
            type="search"
            placeholder="搜索主名或别名…"
            aria-label="搜索合并候选"
            maxLength={256}
            disabled={merging}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            autoFocus
          />

          <div className={styles.pickPanel}>
            {loading ? (
              <EmptyState className={styles.empty} variant="modal" loading />
            ) : pageError && !candidates.total ? (
              <div role="alert" className={styles.pageError}>
                <p>合并候选读取失败</p>
                <Button size="sm" disabled={merging} onClick={candidates.reload}>重试</Button>
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                className={styles.empty}
                variant="modal"
                icon={<SearchX {...UI_ICON_SM} aria-hidden />}
                title={debouncedQ.trim() ? '没有匹配的演员' : '没有可合并的候选演员'}
                description={
                  debouncedQ.trim()
                    ? '调整搜索关键词后再试。'
                    : '当前演员没有同组可合并候选。'
                }
              />
            ) : (
              <ContinuousGrid role="listbox" contained window={candidates.window} scope={`merge:${keepActress.id}:${debouncedQ}`} label="演员列表" itemHeight={68} itemKey={item => item.id} renderItem={item => {
                  const isSelected = selected?.id === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="option"
                      aria-label={`选择合并演员 ${item.main_name}`}
                      aria-selected={isSelected}
                      className={styles.pickItem}
                      disabled={merging}
                      onClick={() => { setSelected(isSelected ? null : item); setMainNameFrom('keep') }}
                    >
                      <span className={styles.pickRadio} aria-hidden="true" />
                      <ActressAvatar
                        src={assetUrl(item.avatar_path)}
                        name={item.main_name}
                        gender={item.gender}
                        className={styles.pickAvatar}
                        decorative
                      />
                      <span className={styles.pickMain}>
                        <span className={styles.pickName}>
                          <ActressName name={item.main_name} gender={item.gender} />
                        </span>
                        <span className={styles.pickMeta}>{item.video_count} 部影片</span>
                      </span>
                    </button>
                  )
                }} />
            )}
          </div>

        </section>

        <section
          className={`${styles.section} ${styles.plan}`}
          data-empty={!selected}
          data-merge-actress-part="plan"
          aria-label="合并方案"
        >
          <div className={styles.sectionTitle}>合并方案</div>
          {selected ? (
            <>
              <div className={styles.nameOptions}>
                <label
                  className={styles.nameOption}
                  data-active={mainNameFrom === 'keep'}
                >
                  <input
                    type="radio"
                    name="merge-main-name"
                    disabled={merging}
                    checked={mainNameFrom === 'keep'}
                    onChange={() => setMainNameFrom('keep')}
                  />
                  <span className={styles.nameCopy}>
                    <span className={styles.nameLabel}>保留当前主名</span>
                    <span className={styles.nameValue}>{keepActress.main_name}</span>
                  </span>
                </label>
                <label
                  className={styles.nameOption}
                  data-active={mainNameFrom === 'merge'}
                >
                  <input
                    type="radio"
                    name="merge-main-name"
                    disabled={merging}
                    checked={mainNameFrom === 'merge'}
                    onChange={() => setMainNameFrom('merge')}
                  />
                  <span className={styles.nameCopy}>
                    <span className={styles.nameLabel}>使用对方主名</span>
                    <span className={styles.nameValue}>{selected.main_name}</span>
                  </span>
                </label>
              </div>

              <ul className={styles.summary}>
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
            <div className={styles.planEmpty}>
              先选择一名要并入的演员，再确认合并后的主名、影片数量和别名处理。
            </div>
          )}
        </section>

        {error && <p ref={errorRef} role="alert" className={styles.error}>{error}</p>}
      </div>
    </Modal>
  )
}
