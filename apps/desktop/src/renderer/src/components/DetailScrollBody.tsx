import ScrollViewport from './ScrollViewport'
import type { ReactNode, RefObject } from 'react'
import BackButton from './BackButton'
import styles from './DetailScrollBody.module.css'

interface DetailScrollBodyProps {
  onBack?: () => void
  scrollRef?: RefObject<HTMLDivElement>
  headerContext?: ReactNode
  children: ReactNode
}

/** Shared scroll container with an optional back/context bar for entity detail pages. */
export default function DetailScrollBody({
  onBack,
  scrollRef,
  headerContext,
  children
}: DetailScrollBodyProps): JSX.Element {
  return (
    <ScrollViewport variant="scroll" ref={scrollRef}>
      <div data-page-content className={styles.content}>
        {onBack || headerContext ? (
          <div className={styles.header}>
            {onBack ? <BackButton variant="inline" onClick={onBack} /> : null}
            {headerContext ? <div className={styles.headerContext}>{headerContext}</div> : null}
          </div>
        ) : null}
        {children}
      </div>
    </ScrollViewport>
  )
}
