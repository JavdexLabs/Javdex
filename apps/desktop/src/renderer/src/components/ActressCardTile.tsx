import type { ActressCard } from '@shared/cardProjection'
import { assetUrl } from '../api'
import ActressAvatar from './ActressAvatar'
import ActressName from './ActressName'
import ActressStatusBadge from './ActressStatusBadge'
import MediaTileActionButton from './MediaTileActionButton'
import CardSelectionButton from './CardSelectionButton'
import styles from './ActressCardTile.module.css'

interface ActressCardTileProps {
  actress: ActressCard
  selected: boolean
  selectionMode: boolean
  onToggleSelect: (event: React.MouseEvent) => void
  onOpen: () => void
  onDelete: () => void
}

export default function ActressCardTile({
  actress,
  selected,
  selectionMode,
  onToggleSelect,
  onOpen,
  onDelete
}: ActressCardTileProps): JSX.Element {
  return (
    <div
      className={styles.root}
      data-actress-card
      data-selected={selected || undefined}
    >
      <CardSelectionButton
        visible={selected || selectionMode}
        selected={selected}
        label={selected ? `取消选择 ${actress.main_name}` : `选择 ${actress.main_name}`}
        onClick={(event) => {
          event.stopPropagation()
          onToggleSelect(event)
        }}
      />
      <button
        type="button"
        className={styles.card}
        aria-pressed={selectionMode ? selected : undefined}
        onClick={(event) => {
          if (selectionMode) {
            onToggleSelect(event)
            return
          }
          onOpen()
        }}
      >
        <span className={styles.avatarWrap}>
          <ActressAvatar
            className={styles.avatar}
            src={assetUrl(actress.avatar_path, 320)}
            name={actress.main_name}
            gender={actress.gender}
          />
          <ActressStatusBadge status={actress.scraped_status} className={styles.status} />
        </span>
        <ActressName
          name={actress.main_name}
          gender={actress.gender}
          className={styles.name}
        />
        <div className={styles.count}>{actress.video_count} 部</div>
      </button>
      {!selectionMode && actress.video_count === 0 ? (
        <MediaTileActionButton
          className={styles.action}
          label={`删除演员 ${actress.main_name}`}
          title="删除"
          onClick={onDelete}
        />
      ) : null}
    </div>
  )
}
