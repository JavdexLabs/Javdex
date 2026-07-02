import { useEffect, useState } from 'react'
import {
  actressGenderMergeLabel,
  canMergeActressGenders
} from '@shared/actressProfileOptions'
import type { ActressDetail, ActressGender, ActressListItem, ActressMergeMainNameFrom } from '@shared/types'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import ActressName from './ActressName'
import ActressAvatar from './ActressAvatar'
import Modal from './Modal'

interface Props {
  keepActress: ActressDetail
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
          <span className="merge-actress-card-placeholder">?</span>
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

export default function MergeActressModal({
  keepActress,
  onCancel,
  onMerged
}: Props): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const debouncedQ = useDebounce(searchInput, 300)
  const [items, setItems] = useState<ActressListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<ActressListItem | null>(null)
  const [mainNameFrom, setMainNameFrom] = useState<ActressMergeMainNameFrom>('keep')
  const [merging, setMerging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    api.actresses
      .list(debouncedQ.trim(), 'all')
      .then((list) =>
        setItems(
          list.filter(
            (item) =>
              item.id !== keepActress.id &&
              canMergeActressGenders(keepActress.gender, item.gender)
          )
        )
      )
      .catch((e) => setError(String((e as Error).message ?? e)))
      .finally(() => setLoading(false))
  }, [debouncedQ, keepActress.gender, keepActress.id])

  useEffect(() => {
    setMainNameFrom('keep')
  }, [selected?.id])

  const doMerge = async (): Promise<void> => {
    if (!selected || merging) return
    setMerging(true)
    setError(null)
    try {
      await api.actresses.merge({
        keepId: keepActress.id,
        mergeId: selected.id,
        mainNameFrom
      })
      onMerged()
    } catch (e) {
      setError(String((e as Error).message ?? e))
    } finally {
      setMerging(false)
    }
  }

  const keepCard: MergeCardActress = {
    main_name: keepActress.main_name,
    gender: keepActress.gender ?? null,
    avatar_path: keepActress.avatar_path,
    video_count: keepActress.videos.length,
    gallery_count: keepActress.gallery.length
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
    selected == null ? keepActress.videos.length : keepActress.videos.length + selected.video_count

  return (
    <Modal
      title="合并演员"
      hint={`将另一名${actressGenderMergeLabel(keepActress.gender)}的资料并入当前条目。仅支持同性别合并；影片与写真会保留，对方记录将被删除。`}
      size="md"
      className="merge-actress-modal"
      onCancel={onCancel}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={merging}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!selected || merging}
            onClick={() => void doMerge()}
          >
            {merging ? '合并中…' : '确认合并'}
          </button>
        </>
      }
    >
      <div className="merge-actress-body">
          <div className="merge-actress-flow" aria-label="合并预览">
            <MergeActressCard actress={keepCard} badge="保留" highlighted />
            <div className="merge-actress-flow-arrow" aria-hidden="true">
              <span>并入</span>
            </div>
            <MergeActressCard
              actress={selectedCard}
              badge="合并"
              empty={!selected}
              highlighted={Boolean(selected)}
            />
          </div>

          <section className="merge-actress-section" aria-label="选择演员">
            <div className="merge-actress-section-head">
              <span className="merge-actress-section-title">选择要合并的演员</span>
              {!loading && items.length > 0 && (
                <span className="merge-actress-section-meta">{items.length} 名候选</span>
              )}
            </div>
            <input
              className="search-input merge-actress-search"
              type="search"
              placeholder="搜索主名或别名…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoFocus
            />

            <div className="merge-actress-pick-panel">
              {loading ? (
                <div className="empty-state empty-state--compact">
                  <div className="spinner" />
                </div>
              ) : items.length === 0 ? (
                <div className="empty-state empty-state--compact">
                  <div>{debouncedQ.trim() ? '没有匹配的演员' : '输入关键词搜索演员'}</div>
                </div>
              ) : (
                <div className="merge-actress-pick-list" role="listbox" aria-label="演员列表">
                  {items.map((item) => {
                    const isSelected = selected?.id === item.id
                    return (
                      <button
                        key={item.id}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`merge-actress-pick-item${isSelected ? ' is-selected' : ''}`}
                        onClick={() => setSelected(isSelected ? null : item)}
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
          </section>

          {selected && (
            <section className="merge-actress-section merge-actress-plan" aria-label="合并方案">
              <div className="merge-actress-section-title">合并后主名</div>
              <div className="merge-name-options">
                <label
                  className={`merge-name-option${mainNameFrom === 'keep' ? ' is-active' : ''}`}
                >
                  <input
                    type="radio"
                    name="merge-main-name"
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
                  合并后约 <strong>{mergedVideoCount}</strong> 部影片关联到「{finalMainName}」
                </li>
                <li>写真与资料字段将合并到保留条目</li>
                {demotedName && (
                  <li>
                    「{demotedName}」将写入别名
                  </li>
                )}
              </ul>
            </section>
          )}

          {error && <p className="merge-actress-error">{error}</p>}
      </div>
    </Modal>
  )
}
