import { useEffect, useMemo, useRef, useState } from 'react'
import { ListVideo } from 'lucide-react'
import { api, assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import { useToast } from './Toast'
import Modal from './Modal'
import EmptyState from './EmptyState'
import { UI_ICON_SM } from './iconDefaults'
import Button from './Button'
import ContinuousGrid from './ContinuousGrid'

export default function PlaylistVideoPicker({ videoIds, single, subtitle, onCancel, onChanged }: {
  videoIds: number[];single?: boolean;subtitle: string;onCancel:()=>void;onChanged?:()=>void
}): JSX.Element {
  const toast = useToast()
  const [query,setQuery] = useState('')
  const [offset,setOffset] = useState(0)
  const [busyId,setBusyId] = useState<number|'create'|null>(null)
  const gate = useRef(false), active = useRef(true)
  const session=useMemo(()=>({videoIds}),[videoIds])
  const current=useRef(session)
  current.current=session
  useEffect(()=>{ active.current=true;return()=>{ active.current=false } },[])
  const search = useDebounce(query.trim(),250)
  const ready = search === query.trim()
  const page = usePlaylistBrowsePage({search,offset,limit:60,videoId:single ? videoIds[0] : undefined,locale:Intl.DateTimeFormat().resolvedOptions().locale})
  const canCreate = ready && !page.loading && !page.error && Boolean(page.data) && Boolean(query.trim()) && !page.data?.hasExactName
  async function change(id: number|'create', remove = false): Promise<void> {
    if (gate.current || !ready || page.loading || page.error || (id==='create' && !canCreate)) return
    gate.current=true;setBusyId(id)
    try {
      const target = id === 'create' ? await api.playlists.create({name:query.trim()}) : id
      let changed=0,failed=0
      for(const video of videoIds) {
        try { if(await (remove ? api.playlists.removeVideo(target,video) : api.playlists.addVideo(target,video))) changed++ }
        catch { failed++ }
      }
      if (!active.current || current.current!==session) return
      const message = failed ? `${id==='create' ? '清单已创建，' : ''}已加入 ${changed} 部，${failed} 部失败`
        : remove ? changed ? '已从清单移出' : '影片不在该清单中'
          : id==='create' ? `清单已创建，已加入 ${changed} 部影片`
            : changed ? `已加入 ${changed} 部影片` : '所选影片已在该清单中'
      toast.show(message,failed ? 'error' : changed || id==='create' ? 'success' : 'info')
      if (id==='create') { setQuery('');setOffset(0) }
      else await page.reload()
      if(active.current && current.current===session) onChanged?.()
    } catch(error) { if(active.current && current.current===session) toast.show(error instanceof Error ? error.message : String(error),'error') }
    finally { gate.current=false;if(active.current)setBusyId(null) }
  }
  const disabled = busyId !== null
  return <Modal title={single ? '加入播放清单' : '批量加入播放清单'} subtitle={subtitle} size="md" className="modal--playlist-picker"
    onCancel={onCancel} closeDisabled={disabled} actions={<Button onClick={onCancel} disabled={disabled}>关闭</Button>}>
    <div className="playlist-pick-panel">
      <div className="playlist-pick-toolbar">
        <input className="text-input playlist-pick-search" value={query} maxLength={500} disabled={disabled} autoFocus
          aria-label="搜索或输入新清单名称" placeholder="搜索或输入新清单名称"
          onChange={event=>{setQuery(event.target.value);setOffset(0)}}
          onKeyDown={event=>{if(event.key==='Enter' && canCreate){event.preventDefault();void change('create')}}}/>
        <Button variant="primary" size="sm" disabled={!canCreate || disabled} title={page.data?.hasExactName ? '已有同名清单，请直接加入' : undefined} onClick={()=>void change('create')}>
          {busyId==='create' ? '创建中…' : '创建并加入'}
        </Button>
      </div>
      {page.loading ? <EmptyState variant="modal" loading/> : page.error && !page.total ? <EmptyState variant="modal" title="清单读取失败" description={page.error}><Button onClick={()=>void page.reload()}>重试</Button></EmptyState>
        : !page.total ? <EmptyState variant="modal" title={search ? '没有匹配的清单' : '暂无播放清单'}/>
          : <ContinuousGrid contained fill window={page.window} scope={`playlist-pick:${search}`} label="清单候选" itemHeight={86} gap={8} itemKey={item=>item.id} renderItem={item=>{
            const cover=assetUrl(item.preview_cover_path,320)
            return <div key={item.id} className="playlist-pick-row">
              <div className="playlist-pick-cover">{cover ? <img src={cover} alt={item.name}/> : <span className="playlist-pick-cover-placeholder"><ListVideo {...UI_ICON_SM}/></span>}</div>
              <div className="playlist-pick-main"><div className="playlist-pick-name">{item.name}</div><div className="playlist-pick-meta">{item.video_count} 部影片</div></div>
              <Button size="sm" disabled={disabled} className={single && item.contains_video ? 'playlist-pick-remove-btn' : ''} onClick={()=>void change(item.id,single && item.contains_video)}>
                {busyId===item.id ? '处理中…' : single && item.contains_video ? '移出' : '加入'}
              </Button>
            </div>
          }} />}

    </div>
  </Modal>
}
