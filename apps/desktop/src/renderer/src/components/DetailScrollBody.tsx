import ScrollViewport from './ScrollViewport'
import { useState, type ReactNode, type RefObject } from 'react'
import BackButton from './BackButton'
import { DetailFooterContext } from './DetailFooterContext'
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
  const [footerHost, setFooterHost] = useState<HTMLDivElement | null>(null)
  return (
    <DetailFooterContext.Provider value={footerHost}>
      <div className={styles.shell}>
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
        <div ref={setFooterHost} className={styles.footer} />
      </div>
    </DetailFooterContext.Provider>
  )
}
