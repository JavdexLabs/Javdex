import PageHeader from '../components/PageHeader'
import ListPage from '../components/ListPage'
import ResultCount from '../components/ResultCount'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { ListVideo, SearchX } from 'lucide-react'
import type { PlaylistCreateInput } from '@shared/playlistTypes'
import { api } from '../api'
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
import PlaylistCard from '../components/PlaylistCard'
import { usePlaylistImport } from '../components/playlistImport/PlaylistImportContext'
import { onPlaylistImportCompleted } from '../components/playlistImport/events'
import { useRecentPlayback } from '../hooks/useRecentPlayback'
import styles from './PlaylistsPage.module.css'

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
  const recent = useRecentPlayback()
  const showRecent = Boolean(recent.metadata && `${recent.metadata.name} ${recent.metadata.description}`.toLowerCase().includes(urlQ.trim().toLowerCase()))
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
  const page=usePlaylistBrowsePage({search:urlQ,offset,limit:PLAYLIST_PAGE_SIZE,kind:'custom'})
  const builtins=usePlaylistBrowsePage({search:urlQ,offset:0,limit:2,kind:'builtin'})
  const builtinItems = [...builtins.items].sort((a, b) => Number(b.system_kind === 'favorites') - Number(a.system_kind === 'favorites'))
  const hasBuiltins = builtinItems.length > 0 || showRecent
  const loading=page.loading
  const reloadCustom=page.reload, reloadBuiltins=builtins.reload
  const loadList=useCallback(() => { reloadCustom(); reloadBuiltins() }, [reloadCustom, reloadBuiltins])
  const move=useCallback((next:number)=>{
    // Search will reset the page on commit; an incidental anchor must not discard its draft.
    if (draft?.context === context && draft.value.trim() !== urlQ.trim()) return
    const normalized=parsePlaylistOffset(String(next))
    if (searchParams.get(LIST_PARAM.playlistOffset) === (normalized ? String(normalized) : null)) return
    setSearchParams(previous=>patchSearchParams(previous,{
      [LIST_PARAM.playlistOffset]:normalized ? String(normalized) : null
    }),{replace:true})
  },[context,draft,urlQ,searchParams,setSearchParams])

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
    const newId = await api.playlists.create(input)
    if(generation.current!==token)return
    setShowCreate(false)
    toast.show('播放清单已创建', 'success')
    await loadList()
    if(generation.current===token)navigateToPlaylistDetail(navigate, location, newId)
  }

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
          variant="compact"
          icon={<ListVideo {...UI_ICON_SM} aria-hidden />}
          title="暂无自定义清单"
          description="创建清单后，可以把影片按主题或待看计划归档。"
        />
      )
    }
    if (!page.total) {
      if (hasBuiltins) return <EmptyState variant="compact" title="没有匹配的自定义清单" />
      return (
        <EmptyState
          icon={<SearchX {...UI_ICON_SM} aria-hidden />}
          title="没有匹配的清单"
          description="调整搜索关键词后再试。"
        />
      )
    }
    return (
      <ContinuousGrid window={page.window} scope={scrollMemoryKey} label="播放清单" minWidth={260} itemHeight={112} pageSize={PLAYLIST_PAGE_SIZE} initialIndex={offset} onAnchor={index => move(Math.floor(index / PLAYLIST_PAGE_SIZE) * PLAYLIST_PAGE_SIZE)} itemKey={item => item.id} renderItem={item => (
        <PlaylistCard key={item.id} item={item} active={activeId === item.id} onOpen={() => navigateToPlaylistDetail(navigate, location, item.id)} />
      )} />
    )
  }

  return (
    <ListPage >
      <PageHeader >
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
            <ResultCount  aria-live="polite">
              共 {page.known && builtins.known ? page.total + builtins.total + (showRecent ? 1 : 0) : '…'} 个
            </ResultCount>
          }
        />
      </PageHeader>

      <ListSurface
        variant="scroll"
        scrollRef={scrollRef}
        showScrollToTop={showScrollToTop}
        onScrollToTop={scrollToTop}
      >
        {hasBuiltins && <section className={styles.builtinSection} aria-label="内置清单">
          <h2 className={styles.sectionTitle}>内置清单</h2>
          <div className={styles.builtinGrid}>
            {builtinItems.map(item => <PlaylistCard key={item.id} item={item} compact active={activeId === item.id}
              onOpen={() => navigateToPlaylistDetail(navigate, location, item.id)} />)}
            {showRecent && recent.metadata && <PlaylistCard item={recent.metadata} compact active={activeId === recent.metadata.id}
              onOpen={() => navigateToPlaylistDetail(navigate, location, recent.metadata!.id)} />}
          </div>
        </section>}
        {builtins.error && <EmptyState variant="compact" title="内置清单读取失败" description={builtins.error}>
          <Button onClick={() => builtins.reload()}>重试</Button>
        </EmptyState>}
        {recent.error && <EmptyState variant="compact" title="本机最近播放读取失败" description={recent.error}>
          <Button onClick={() => void recent.reload()}>重试</Button>
        </EmptyState>}
        <section className={styles.customSection} aria-label="我的清单">
          <h2 className={styles.sectionTitle}>我的清单 <span className={styles.sectionCount}>{page.known ? `共 ${page.total} 个` : '…'}</span></h2>
          {renderList()}
        </section>
      </ListSurface>



      {showCreate && (
        <PlaylistCreateModal onCancel={() => setShowCreate(false)} onCreate={createPlaylist} />
      )}
    </ListPage>
  )
}
