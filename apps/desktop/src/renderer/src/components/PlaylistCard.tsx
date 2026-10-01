import type { PlaylistBrowseItem } from '@shared/playlistTypes'
import { assetUrl } from '../api'
import PlaylistCover from './PlaylistCover'
import styles from './PlaylistCard.module.css'

export default function PlaylistCard({ item, active, onOpen }: {
  item: PlaylistBrowseItem
  active: boolean
  onOpen: () => void
}): JSX.Element {
  const cover = assetUrl(item.preview_cover_path, 640)
  return (
    <button
      type="button"
      className={styles.root}
      data-playlist-card
      data-active={active || undefined}
      onClick={onOpen}
    >
      <PlaylistCover variant="card">
        {cover ? <img src={cover} alt={item.name} /> : <span>无封面</span>}
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
