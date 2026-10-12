import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import PlaylistCover from './PlaylistCover'
import styles from './PlaylistCard.module.css'

export default function PlaylistCard({ item, active, onOpen }: {
  item: PlaylistBrowseItem & { local_kind?: 'recently_played' }
  active: boolean
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={styles.root}
      data-playlist-card
      data-active={active || undefined}
      onClick={onOpen}
    >
      <PlaylistCover variant="card" playlist={item}>
        <span className={styles.count}>{item.video_count}</span>
      </PlaylistCover>
      <div className={styles.main}>
        <div className={styles.name}>{item.name}</div>
        <div className={styles.meta}>{item.video_count} 部影片</div>
        <div className={`${styles.description}${item.description ? '' : ` ${styles.emptyDescription}`}`}>
          {item.description || '暂无简介'}
        </div>
      </div>
    </button>
  )
}
