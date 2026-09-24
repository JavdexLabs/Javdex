import type { VideoCard } from '@shared/videoTypes'
import type { ContinuousWindow } from '../hooks/useContinuousPage'
import ContinuousGrid from './ContinuousGrid'
import PosterCard from './PosterCard'
import { useDisplayMode } from './DisplayModeContext'
import { DETAIL_POSTER_MIN_COL_WIDTH, DETAIL_LANDSCAPE_MIN_COL_WIDTH, PORTRAIT_HEIGHT_PER_WIDTH, LANDSCAPE_HEIGHT_PER_WIDTH, POSTER_META_HEIGHT } from '../coverAspect'

export default function ContinuousPosterGrid<T extends VideoCard>({ window, scope, onRemove, removeDisabled, initialIndex, onAnchor }: {
  window: ContinuousWindow<T>; scope: string; onRemove?: (video: T) => void; removeDisabled?: boolean; initialIndex?: number; onAnchor?: (index: number) => void
}): JSX.Element {
  const { mode } = useDisplayMode()
  return <ContinuousGrid window={window} scope={scope} initialIndex={initialIndex} onAnchor={onAnchor} pageSize={onAnchor ? 60 : undefined} label="影片" itemKey={video => video.id}
    minWidth={mode === 'portrait' ? DETAIL_POSTER_MIN_COL_WIDTH : DETAIL_LANDSCAPE_MIN_COL_WIDTH}
    itemHeight={width => width * (mode === 'portrait' ? PORTRAIT_HEIGHT_PER_WIDTH : LANDSCAPE_HEIGHT_PER_WIDTH) + POSTER_META_HEIGHT}
    renderItem={video => <PosterCard video={video} onRemove={onRemove ? () => onRemove(video) : undefined} removeDisabled={removeDisabled} />} />
}
