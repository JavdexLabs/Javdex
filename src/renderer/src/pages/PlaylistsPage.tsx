import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { ListVideo, SearchX } from 'lucide-react'
import type { PlaylistCreateInput, PlaylistBrowseItem } from '@shared/playlistTypes'
import { api, assetUrl } from '../api'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import PlaylistBrowsePager from '../components/PlaylistBrowsePager'
import { LIST_PARAM, patchSearchParams } from '../listView/listQueryParams'
import { navigateToPlaylistDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useToast } from '../components/Toast'
import PlaylistCreateModal from '../components/PlaylistCreateModal'
import ListToolbar from '../components/ListToolbar'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useScrollContainerMemory } from '../hooks/useScrollContainerMemory'
import EmptyState from '../components/EmptyState'
import ListSurface from '../components/ListSurface'
import { UI_ICON_SM } from '../components/iconDefaults'
import Button from '../components/Button'
import { usePlaylistImport } from '../components/playlistImport/PlaylistImportContext'
import { onPlaylistImportCompleted } from '../components/playlistImport/events'

function playlistListCover(item: PlaylistBrowseItem): string | null {
  return assetUrl(item.preview_cover_path, 640)
}

export default function PlaylistsPage(): JSX.Element {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const playlistImport = usePlaylistImport()
  const detailMatch = useMatch(ROUTE_MATCH.playlistDetailOpen)
  const detailOpen = Boolean(detailMatch)
  const activeId = detailMatch ? Number(detailMatch.params.playlistId) : null
  const [searchParams, setSearchParams] = useSearchParams()
  const [showCreate, setShowCreate] = useState(false)

  const dismissOverlays = useCallback(() => {
    setShowCreate(false)
  }, [])

  useDismissOverlaysOnNavigate(dismissOverlays, location.pathname)

  const urlQ = searchParams.get(LIST_PARAM.q) ?? ''
  const context = `${location.key}:${location.pathname}:${location.search}`
  const [draft,setDraft] = useState<{context:string;value:string}>()
  const searchInput = draft?.context === context ? draft.value : urlQ
  const setSearchInput = (value:string):void => setDraft({context,value})
  useEffect(()=>{ if(draft && draft.context!==context)setDraft(undefined) },[context,draft])
  useEffect(()=>{
    if(!draft || draft.context!==context || draft.value.trim()===urlQ.trim())return
    const timer=setTimeout(()=>setSearchParams(previous=>patchSearchParams(previous,{
      [LIST_PARAM.q]:draft.value.trim() || null,[LIST_PARAM.playlistOffset]:null
    }),{replace:true}),300)
    return ()=>clearTimeout(timer)
  },[context,draft,urlQ,setSearchParams])
  const rawOffset=Number(searchParams.get(LIST_PARAM.playlistOffset) ?? 0)
  const offset=Number.isSafeInteger(rawOffset) && rawOffset>=0 ? rawOffset : 0
  const ready=searchInput.trim()===urlQ.trim()
  const page=usePlaylistBrowsePage({search:urlQ,offset,limit:60},!detailOpen && ready)
  const items=page.data?.items ?? []
  const filteredItems=items
  const loading=page.loading || !ready
  const loadList=page.reload
  const move=useCallback((next:number)=>setSearchParams(previous=>patchSearchParams(previous,{
    [LIST_PARAM.playlistOffset]:next ? String(next) : null
  }),{replace:true}),[setSearchParams])
  useEffect(()=>{ if(page.data && page.data.offset!==offset)move(page.data.offset) },[page.data,offset,move])
  const session=useMemo(()=>({context}),[context])
  const current=useRef(session)
  current.current=session
  const scrollMemoryKey=`playlists:q=${urlQ}:offset=${offset}`
  const { ref: scrollRef, showScrollToTop, scrollToTop } = useScrollContainerMemory(scrollMemoryKey)

  useEffect(() => onPlaylistImportCompleted(() => {
    void loadList()
  }), [loadList])

  const createPlaylist = async (input: PlaylistCreateInput): Promise<void> => {
    try {
      const newId = await api.playlists.create(input)
      if(current.current!==session)return
      setShowCreate(false)
      toast.show('播放清单已创建', 'success')
      await loadList()
      if(current.current===session)navigateToPlaylistDetail(navigate, location, newId)
    } catch (e) {
      toast.show(String((e as Error).message), 'error')
    }
  }

  const renderCover = (cover: string | null, label: string): JSX.Element =>
    cover ? <img src={cover} alt={label} /> : <span>无封面</span>

  const renderList = (): JSX.Element => {
    if (loading) {
      return <EmptyState loading />
    }
    if (page.error) return <div role="alert">{page.error}<Button onClick={()=>void loadList()}>重试</Button></div>
    if (items.length === 0 && !urlQ) {
      return (
        <EmptyState
          icon={<ListVideo {...UI_ICON_SM} aria-hidden />}
          title="暂无清单"
          description="创建清单后，可以把影片按主题或待看计划归档。"
        />
      )
    }
    if (filteredItems.length === 0) {
      return (
        <EmptyState
          icon={<SearchX {...UI_ICON_SM} aria-hidden />}
          title="没有匹配的清单"
          description="调整搜索关键词后再试。"
        />
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
            <>
              <Button
                type="button"
                size="sm"
                onClick={() => playlistImport.open({
                  destination: { kind: 'create' }
                })}
              >
                导入外部清单
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setShowCreate(true)}
              >
                创建清单
              </Button>
            </>
          }
          resultCount={
            <span className="count-badge count-badge--stable" aria-live="polite">
              共 {page.data?.total ?? '…'} 个
            </span>
          }
        />
      </div>

      <ListSurface
        variant="scroll"
        scrollRef={scrollRef}
        showScrollToTop={showScrollToTop}
        onScrollToTop={scrollToTop}
      >
        {renderList()}
      </ListSurface>

      <PlaylistBrowsePager offset={page.data?.offset ?? offset} limit={60} total={page.data?.total ?? 0} disabled={loading || Boolean(page.error)} onPage={move}/>

      {showCreate && (
        <PlaylistCreateModal onCancel={() => setShowCreate(false)} onCreate={createPlaylist} />
      )}
    </div>
  )
}
