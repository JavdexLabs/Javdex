import { useEffect, useMemo, useState } from 'react'
import { SearchX } from 'lucide-react'
import type { ActressListItem, Video } from '@shared/types'
import { api, resolveMediaSrc } from '../../api'
import { useDebounce } from '../../hooks/useDebounce'
import Modal from '../Modal'
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
const ACTRESS_RESULT_LIMIT = 80

function normalizeTarget(value: string): string {
  return value.trim().toLowerCase()
}

function formatDate(value: string | null): string {
  if (!value) return '未发行'
  return value.slice(0, 10)
}

function titleForKind(kind: PluginKind): string {
  return kind === 'actress' ? '选择测试演员' : '选择测试番号'
}

export default function PluginDevMediaTargetPicker({
  kind,
  selectedValues,
  onAdd,
  onClose
}: Props): JSX.Element {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 250)
  const [videos, setVideos] = useState<Video[]>([])
  const [videoTotal, setVideoTotal] = useState(0)
  const [actresses, setActresses] = useState<ActressListItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selectedSet = useMemo(
    () => new Set(selectedValues.map((value) => normalizeTarget(value))),
    [selectedValues]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async (): Promise<void> => {
      if (kind === 'actress') {
        const items = await api.actresses.list(
          debouncedSearch.trim(),
          'female',
          'video_count',
          'desc'
        )
        if (cancelled) return
        setActresses(items.slice(0, ACTRESS_RESULT_LIMIT))
        setVideos([])
        setVideoTotal(items.length)
        return
      }

      const result = await api.videos.list({
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
  }, [debouncedSearch, kind])

  const resultCount = kind === 'actress' ? actresses.length : videos.length
  const totalCount = kind === 'actress' ? videoTotal : videoTotal

  return (
    <Modal
      title={titleForKind(kind)}
      size="lg"
      className="modal--plugin-dev-target-picker"
      bodyClassName="modal-body--fixed"
      confirmText="完成"
      cancelText="关闭"
      onConfirm={onClose}
      onCancel={onClose}
    >
      <div className="plugin-dev-target-picker">
        <div className="plugin-dev-target-picker-head">
          <input
            className="text-input"
            value={search}
            placeholder={kind === 'actress' ? '搜索演员名或别名…' : '搜索番号、标题或演员…'}
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
          />
          <span className="plugin-dev-target-picker-count">
            {loading ? '加载中…' : `${resultCount}/${totalCount}`}
          </span>
        </div>

        {error ? <div className="plugin-dev-target-picker-error">{error}</div> : null}

        <div className="plugin-dev-target-picker-list" role="list">
          {kind === 'actress'
            ? actresses.map((actress) => {
                const selected = selectedSet.has(normalizeTarget(actress.main_name))
                return (
                  <button
                    key={actress.id}
                    type="button"
                    className={`plugin-dev-target-picker-row${selected ? ' is-selected' : ''}`}
                    disabled={selected}
                    onClick={() => onAdd(actress.main_name)}
                  >
                    <ActressAvatar
                      src={resolveMediaSrc(actress.avatar_path)}
                      name={actress.main_name}
                      gender={actress.gender}
                      className="plugin-dev-target-picker-avatar"
                      decorative
                    />
                    <span className="plugin-dev-target-picker-main">
                      <strong>
                        <ActressName name={actress.main_name} gender={actress.gender} />
                      </strong>
                      <small>{actress.video_count} 部影片</small>
                    </span>
                    <span className="plugin-dev-target-picker-action">
                      {selected ? '已添加' : '添加'}
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
      </div>
    </Modal>
  )
}
