import type { ReactNode } from 'react'
import { Check, ListVideo } from 'lucide-react'
import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import { UI_ICON_SM } from './iconDefaults'
import PlaylistCover from './PlaylistCover'
import styles from './PlaylistPickerRow.module.css'

export default function PlaylistPickerRow({ item, action, onSelect, disabled = false, selected = false, variant = 'default' }: {
  item: PlaylistBrowseItem
  action?: ReactNode
  onSelect?: () => void
  disabled?: boolean
  selected?: boolean
  variant?: 'default' | 'option'
}): JSX.Element {
  const content = <>
    <PlaylistCover variant={variant === 'option' ? 'option' : 'pick'} playlist={item} placeholder={<span><ListVideo {...UI_ICON_SM} /></span>} />
    <div className={styles.main}>
      <div className={styles.name}>{item.name}</div>
      <div className={styles.meta}>{item.video_count} 部影片</div>
    </div>
    {variant === 'option' ? <Check {...UI_ICON_SM} className={styles.check} data-selected={selected || undefined} /> : action}
  </>
  return onSelect ? (
    <button type="button" className={`${styles.root}${variant === 'option' ? ` ${styles.option}` : ''}`} data-playlist-picker-row title={item.name}
      role={variant === 'option' ? 'option' : undefined} disabled={disabled}
      aria-label={variant === 'option' ? `${item.name}，${item.video_count} 部影片` : undefined}
      aria-selected={variant === 'option' ? selected : undefined} aria-pressed={variant === 'default' ? selected : undefined} onClick={onSelect}>
      {content}
    </button>
  ) : <div className={styles.root} data-playlist-picker-row>{content}</div>
}
