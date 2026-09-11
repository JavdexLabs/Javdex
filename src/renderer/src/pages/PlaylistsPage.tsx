import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { ListVideo, SearchX } from 'lucide-react'
import type { PlaylistCreateInput, PlaylistBrowseItem } from '@shared/playlistTypes'
import { api, assetUrl } from '../api'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import ContinuousGrid from '../components/ContinuousGrid'
import { LIST_PARAM, PLAYLIST_PAGE_SIZE, parsePlaylistOffset, patchSearchParams } from '../listView/listQueryParams'
import { navigateToPlaylistDetail } from '../listView/listNavigation'
import { ROUTE_MATCH } from '../listView/routePaths'
import { useToast } from '../components/Toast'
import PlaylistCreateModal from '../components/PlaylistCreateModal'
import ListToolbar from '../components/ListToolbar'
import { useDismissOverlaysOnNavigate } from '../hooks/useDismissOverlaysOnNavigate'
import { useListSurfaceRefetch } from '../hooks/useListSurfaceRefetch'
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
  const offset=parsePlaylistOffset(searchParams.get(LIST_PARAM.playlistOffset))
  const page=usePlaylistBrowsePage({search:urlQ,offset,limit:PLAYLIST_PAGE_SIZE})
  const loading=page.loading
  const loadList=page.reload
  const move=useCallback((next:number)=>{
    const normalized=parsePlaylistOffset(String(next))
    setSearchParams(previous=>patchSearchParams(previous,{
      [LIST_PARAM.playlistOffset]:normalized ? String(normalized) : null
    }),{replace:true})
  },[setSearchParams])

  const generation=useRef(0)
  useEffect(()=>{
    const token=generation.current+1
    generation.current=token
    return ()=>{ generation.current=token+1 }
  },[context])
  const refetchSilent=useCallback(()=>{ void loadList() },[loadList])
  useListSurfaceRefetch(detailOpen, refetchSilent)
  const scrollMemoryKey=`playlists:q=${urlQ}`
  const { ref: scrollRef, showScrollToTop, scrollToTop } = useScrollContainerMemory(scrollMemoryKey, false)

  useEffect(() => onPlaylistImportCompleted(() => {
    void loadList()
  }), [loadList])

  const createPlaylist = async (input: PlaylistCreateInput): Promise<void> => {
    const token=generation.current
    try {
      const newId = await api.playlists.create(input)
      if(generation.current!==token)return
      setShowCreate(false)
      toast.show('播放清单已创建', 'success')
      await loadList()
      if(generation.current===token)navigateToPlaylistDetail(navigate, location, newId)
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
    if (page.error && !page.total) {
      return (
        <EmptyState title="播放清单加载失败" description={page.error}>
          <Button onClick={() => void loadList()}>重试</Button>
        </EmptyState>
      )
    }
    if (!page.total && !urlQ) {
      return (
        <EmptyState
          icon={<ListVideo {...UI_ICON_SM} aria-hidden />}
          title="暂无清单"
          description="创建清单后，可以把影片按主题或待看计划归档。"
        />
      )
    }
    if (!page.total) {
      return (
        <EmptyState
          icon={<SearchX {...UI_ICON_SM} aria-hidden />}
          title="没有匹配的清单"
          description="调整搜索关键词后再试。"
        />
      )
    }
    return (
      <ContinuousGrid window={page.window} scope={scrollMemoryKey} label="播放清单" minWidth={260} itemHeight={112} pageSize={PLAYLIST_PAGE_SIZE} initialIndex={offset} onAnchor={index => move(Math.floor(index / PLAYLIST_PAGE_SIZE) * PLAYLIST_PAGE_SIZE)} itemKey={item => item.id} renderItem={item => {
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
        }} />
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
              共 {page.known ? page.total : '…'} 个
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



      {showCreate && (
        <PlaylistCreateModal onCancel={() => setShowCreate(false)} onCreate={createPlaylist} />
      )}
    </div>
  )
}
