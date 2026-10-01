import type { ReactNode } from 'react'
import { ListVideo } from 'lucide-react'
import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import { assetUrl } from '../api'
import { UI_ICON_SM } from './iconDefaults'
import PlaylistCover from './PlaylistCover'
import styles from './PlaylistPickerRow.module.css'

export default function PlaylistPickerRow({ item, action, onSelect, disabled = false, selected = false }: {
  item: PlaylistBrowseItem
  action?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  selected?: boolean
}): JSX.Element {
  const cover = assetUrl(item.preview_cover_path, 320)
  const content = <>
    <PlaylistCover variant="pick">
      {cover ? <img src={cover} alt={item.name} /> : <span><ListVideo {...UI_ICON_SM} /></span>}
    </PlaylistCover>
    <div className={styles.main}>
      <div className={styles.name}>{item.name}</div>
      <div className={styles.meta}>{item.video_count} 部影片</div>
    </div>
    {action}
  </>
  return onSelect ? (
    <button type="button" className={styles.root} data-playlist-picker-row title={item.name}
      disabled={disabled} aria-pressed={selected} onClick={onSelect}>
      {content}
    </button>
  ) : <div className={styles.root} data-playlist-picker-row>{content}</div>
}
