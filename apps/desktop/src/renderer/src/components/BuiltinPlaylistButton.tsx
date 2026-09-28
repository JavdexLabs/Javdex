import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Heart, Clock } from 'lucide-react'
import type { VideoCard } from '@shared/videoTypes'
import { expectedPlaylistVersion } from '@shared/protocol/versions'
import { api } from '../api'
import { useToast } from './Toast'
import IconButton from './IconButton'
import { UI_ICON } from './iconDefaults'
import styles from './BuiltinPlaylistButton.module.css'

export default function BuiltinPlaylistButton({ video, kind }: { video: VideoCard; kind: 'favorites' | 'watch_later' }): JSX.Element {
  const initial = Boolean(kind === 'favorites' ? video.is_favorite : video.is_watch_later)
  const [selected, setSelected] = useState(initial)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const queryClient = useQueryClient()
  useEffect(() => setSelected(initial), [initial, video.id])
  useEffect(() => {
    const listener = (event: Event): void => {
      const change = (event as CustomEvent<{ videoId: number; kind: string; selected: boolean }>).detail
      if (change.videoId === video.id && change.kind === kind) setSelected(change.selected)
    }
    window.addEventListener('builtin-playlist-changed', listener)
    return () => window.removeEventListener('builtin-playlist-changed', listener)
  }, [kind, video.id])
  const name = kind === 'favorites' ? '我喜欢' : '稍后观看'
  return <IconButton className={`poster-icon-action poster-hover-control ${kind === 'favorites' ? 'poster-edit-action' : styles.watch} ${selected ? (kind === 'favorites' ? styles.favorite : styles.selected) : ''}`}
    icon={kind === 'favorites' ? <Heart {...UI_ICON} fill={selected ? 'currentColor' : 'none'} /> : <Clock {...UI_ICON} />}
    label={`${selected ? '移出' : '加入'}${name}`} title={`${selected ? '移出' : '加入'}${name}`}
    aria-pressed={selected} disabled={busy}
    onClick={async event => {
      event.stopPropagation()
      if (busy) return
      setBusy(true)
      try {
        const memberships = await api.playlists.listForVideo(video.id)
        const playlist = memberships.find(p => p.system_kind === kind)
        if (!playlist) throw new Error('默认清单不存在，请更新资料库服务后重试')
        const next = !playlist.contains_video
        if (next) await api.playlists.addVideo(playlist.id, video.id, expectedPlaylistVersion(playlist))
        else await api.playlists.removeVideo(playlist.id, video.id, expectedPlaylistVersion(playlist))
        setSelected(next)
        void queryClient.invalidateQueries()
        window.dispatchEvent(new CustomEvent('builtin-playlist-changed', { detail: { videoId: video.id, kind, selected: next } }))
      } catch (error) { toast.show((error as Error).message, 'error') }
      finally { setBusy(false) }
    }} />
}
