import styles from './PlaylistDestinationPicker.module.css'
import { useState } from 'react'
import { ListVideo } from 'lucide-react'
import { assetUrl } from '../api'
import { useDebounce } from '../hooks/useDebounce'
import { usePlaylistBrowsePage } from '../hooks/usePlaylistBrowsePage'
import ContinuousGrid from './ContinuousGrid'
import EmptyState from './EmptyState'
import Button from './Button'
import { UI_ICON_SM } from './iconDefaults'

export default function PlaylistDestinationPicker({ value, label, onChange, disabled = false }: {
  value: string; label?: string; onChange: (id: string, label: string) => void; disabled?: boolean
}): JSX.Element {
  const [input, setInput] = useState('')
  const search = useDebounce(input.trim(), 250)
  const page = usePlaylistBrowsePage({ search, limit: 60 })
  return <div className={styles.root}>
    <input className="text-input form-control-full" aria-label="搜索目标清单" placeholder="搜索目标清单" maxLength={500} value={input} disabled={disabled} onChange={event => setInput(event.target.value)} />
    <p className={styles.selection} aria-live="polite" title={label}>{value ? `已选：${label || `清单 #${value}`}` : '选择要追加影片的清单'}</p>
    <div className={styles.list}>
      {page.loading ? <EmptyState variant="modal" loading/> : page.error && !page.total ? <EmptyState variant="modal" title="清单读取失败" description={page.error}><Button onClick={() => void page.reload()}>重试</Button></EmptyState>
        : !page.total ? <EmptyState variant="modal" title={search ? '没有匹配的清单' : '暂无播放清单'}/>
        : <ContinuousGrid contained fill window={page.window} scope={`playlist-destination:${search}`} label="目标清单" itemHeight={86} gap={8} itemKey={item => item.id}
          renderItem={item => {
            const cover = assetUrl(item.preview_cover_path, 320)
            return <button type="button" className={`playlist-pick-row ${styles.row}`} title={item.name} disabled={disabled}
              aria-pressed={String(item.id) === value} onClick={() => onChange(String(item.id), item.name)}>
              <div className="playlist-pick-cover">{cover ? <img src={cover} alt={item.name} /> : <span className="playlist-pick-cover-placeholder"><ListVideo {...UI_ICON_SM} /></span>}</div>
              <div className="playlist-pick-main">
                <div className="playlist-pick-name">{item.name}</div>
                <div className="playlist-pick-meta">{item.video_count} 部影片</div>
              </div>
            </button>
          }} />}
    </div>
  </div>
}
