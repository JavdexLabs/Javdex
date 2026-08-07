import type { ActressListItem } from '@shared/types'
import { assetUrl } from '../api'
import ActressAvatar from './ActressAvatar'
import ActressName from './ActressName'
import ActressStatusBadge from './ActressStatusBadge'
import MediaTileActionButton from './MediaTileActionButton'

interface ActressCardTileProps {
  actress: ActressListItem
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
      className={`actress-card-wrap${selected ? ' is-selected' : ''}${selectionMode ? ' is-selection-mode' : ''}`}
    >
      <button
        type="button"
        className={`poster-select-toggle poster-hover-control${selected || selectionMode ? ' is-visible' : ''}${selected ? ' is-checked' : ''}`}
        aria-label={selected ? `取消选择 ${actress.main_name}` : `选择 ${actress.main_name}`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          onToggleSelect(event)
        }}
      />
      <button
        type="button"
        className="actress-card card-interactive"
        aria-pressed={selectionMode ? selected : undefined}
        onClick={(event) => {
          if (selectionMode) {
            onToggleSelect(event)
            return
          }
          onOpen()
        }}
      >
        <span className="actress-card-avatar">
          <ActressAvatar
            src={assetUrl(actress.avatar_path)}
            name={actress.main_name}
            gender={actress.gender}
          />
          <ActressStatusBadge status={actress.scraped_status} />
        </span>
        <ActressName
          name={actress.main_name}
          gender={actress.gender}
          className="actress-name"
        />
        <div className="actress-count">{actress.video_count} 部</div>
      </button>
      {!selectionMode && actress.video_count === 0 ? (
        <MediaTileActionButton
          label={`删除演员 ${actress.main_name}`}
          title="删除"
          onClick={onDelete}
        />
      ) : null}
    </div>
  )
}
