import type { ReactNode, Ref } from 'react'
import ListSurface from './ListSurface'
import styles from './ClassificationDetailSurface.module.css'

interface Props {
  children: ReactNode
  scrollRef?: Ref<HTMLDivElement>
  showScrollToTop?: boolean
  onScrollToTop?: () => void
}

export default function ClassificationDetailSurface({
  children,
  scrollRef,
  showScrollToTop,
  onScrollToTop
}: Props): JSX.Element {
  return (
    <ListSurface
      variant="scroll"
      scrollRef={scrollRef}
      innerClassName={styles.inner}
      showScrollToTop={showScrollToTop}
      onScrollToTop={onScrollToTop}
    >
      {children}
    </ListSurface>
  )
}

export function ClassificationVideoHeading(): JSX.Element {
  return <div className={styles.videoHeading}>关联影片</div>
}
