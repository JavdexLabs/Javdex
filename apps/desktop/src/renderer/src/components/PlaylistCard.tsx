import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import PlaylistCover from './PlaylistCover'
import styles from './PlaylistCard.module.css'

export default function PlaylistCard({ item, active, onOpen, compact = false }: {
  item: PlaylistBrowseItem & { local_kind?: 'recently_played' }
  active: boolean
  onOpen: () => void
  compact?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.root}
      data-playlist-card
      data-compact={compact || undefined}
      data-active={active || undefined}
      onClick={onOpen}
    >
      <PlaylistCover variant={compact ? 'shortcut' : 'card'} playlist={item} />
      <div className={styles.main}>
        <div className={styles.name}>{item.system_kind === 'favorites' ? '收藏' : item.name}</div>
        <div className={styles.meta}>{item.video_count} 部影片{compact && item.local_kind === 'recently_played' ? ' · 仅此设备' : ''}</div>
        {!compact && <div className={`${styles.description}${item.description ? '' : ` ${styles.emptyDescription}`}`}>
          {item.description || '暂无简介'}
        </div>}
      </div>
    </button>
  )
}
