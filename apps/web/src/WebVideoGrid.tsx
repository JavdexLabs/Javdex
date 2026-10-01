import { cloneElement, useState } from 'react'
import type { WebVideo } from '../../../packages/contracts/src/webTypes'
import styles from './WebVideoGrid.module.css'

export default function WebVideoGrid({ videos, renderCard }: {
  videos: WebVideo[]
  renderCard: (video: WebVideo) => JSX.Element
}): JSX.Element {
  const [activeId, setActiveId] = useState<number | null>(null)
  const tabStop = videos.some(video => video.id === activeId) ? activeId : videos[0]?.id
  return <div className={styles.root} data-navigation-group aria-label="影片列表">
    {videos.map(video => cloneElement(renderCard(video), {
      tabIndex: video.id === tabStop ? 0 : -1,
      'data-navigation-item': true,
      onFocus: () => setActiveId(video.id)
    }))}
  </div>
}
