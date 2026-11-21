import { useState, type ReactNode, type Ref } from 'react'
import ListSurface from './ListSurface'
import { DetailFooterContext } from './DetailFooterContext'
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
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null)
  return (
    <DetailFooterContext.Provider value={footerHost}>
      <div className={styles.shell}>
        <ListSurface
          variant="scroll"
          scrollRef={scrollRef}
          innerClassName={styles.inner}
          showScrollToTop={showScrollToTop}
          onScrollToTop={onScrollToTop}
        >
          {children}
        </ListSurface>
        <div ref={setFooterHost} className={styles.footer} />
      </div>
    </DetailFooterContext.Provider>
  )
}

export function ClassificationVideoHeading(): JSX.Element {
  return <div className={styles.videoHeading}>关联影片</div>
}
