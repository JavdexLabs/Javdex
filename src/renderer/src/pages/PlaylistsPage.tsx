import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import type { PlaylistCreateInput, PlaylistListItem } from '@shared/types'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { navigateToPlaylistDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useToast } from '../components/Toast'
import PlaylistCreateModal from '../components/PlaylistCreateModal'
import ListToolbar from '../components/ListToolbar'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'

function playlistListCover(item: PlaylistListItem): string | null {
  return assetUrl(item.preview_cover_path)
}

export default function PlaylistsPage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const detailMatch = useMatch(ROUTE_MATCH.playlistDetailOpen)
  const detailOpen = Boolean(detailMatch)
  const activeId = detailMatch ? Number(detailMatch.params.playlistId) : null
  const [searchParams, setSearchParams] = useSearchParams()
  const [items, setItems] = useState<PlaylistListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)

  const dismissOverlays = useCallback(() => {
    setShowCreate(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const [searchInput, setSearchInput] = useState(urlQ)
  useEffect(() => {
    setSearchInput(urlQ)
  }, [urlQ])
  const debouncedQ = useDebounce(searchInput.trim(), 300)

  useEffect(() => {
    const trimmed = debouncedQ.trim()
    if (trimmed === urlQ.trim()) return
    setSearchParams(
      (prev) => patchSearchParams(prev, { [LIST_PARAM.q]: trimmed || null }),
      { replace: true }
    )
  }, [debouncedQ, urlQ, setSearchParams])

  const filteredItems = useMemo(() => {
    if (!debouncedQ) return items
    const q = debouncedQ.toLowerCase()
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false)
    )
  }, [debouncedQ, items])

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems(await api.playlists.list())
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useListSurfaceRefetch(detailOpen, () => {
    void loadList()
  })

  const createPlaylist = async (input: PlaylistCreateInput): Promise<void> => {
    try {
      const newId = await api.playlists.create(input)
      setShowCreate(false)
      toast.show('播放清单已创建', 'success')
      await loadList()
      navigateToPlaylistDetail(navigate, location, newId)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const renderCover = (cover: string | null, label: string): JSX.Element =>
    cover ? <img src={cover} alt={label} /> : <span>无封面</span>

  const renderList = (): JSX.Element => {
    if (loading) {
      return (
        <div className="empty-state">
          <div className="spinner" />
        </div>
      )
    }
    if (items.length === 0) {
      return (
        <div className="empty-state">
          <div className="big">▦</div>
          <div>暂无清单。</div>
        </div>
      )
    }
    if (filteredItems.length === 0) {
      return (
        <div className="empty-state">
          <div className="big">▦</div>
          <div>没有匹配的清单。</div>
        </div>
      )
    }
    return (
      <div className="playlist-grid">
        {filteredItems.map((item) => {
          const cover = playlistListCover(item)
          return (
            <button
              key={item.id}
              type="button"
              className={`playlist-card card-interactive${activeId === item.id ? ' active' : ''}`}
              onClick={() => navigateToPlaylistDetail(navigate, location, item.id)}
            >
              <div className="playlist-card-cover">
                {renderCover(cover, item.name)}
                <span className="playlist-card-count">{item.video_count}</span>
              </div>
              <div className="playlist-card-main">
                <div className="playlist-card-name">{item.name}</div>
                <div className="playlist-card-meta">{item.video_count} 部影片</div>
                {item.description ? (
                  <div className="playlist-card-desc">{item.description}</div>
                ) : (
                  <div className="playlist-card-desc playlist-card-desc--empty">暂无简介</div>
                )}
              </div>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className="list-page">
      <div className="topbar">
        <ListToolbar
          search={{
            value: searchInput,
            placeholder: '搜索清单…',
            ariaLabel: '搜索清单',
            onChange: setSearchInput
          }}
          controls={
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setShowCreate(true)}
            >
              创建清单
            </button>
          }
          resultCount={
            <span className="count-badge count-badge--stable" aria-live="polite">
              共 {debouncedQ ? filteredItems.length : items.length} 个
            </span>
          }
        />
      </div>

      <div className="list-scroll-region">
        <div className="scroll-body scroll-body--scroll">
          <div className="scroll-body-inner">{renderList()}</div>
        </div>
      </div>

      {showCreate && (
        <PlaylistCreateModal onCancel={() => setShowCreate(false)} onCreate={createPlaylist} />
      )}
    </div>
  )
}
