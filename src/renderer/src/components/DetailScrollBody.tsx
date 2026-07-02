import type { ReactNode, RefObject } from 'react'
import BackButton from './BackButton'

interface DetailScrollBodyProps {
  onBack?: () => void
  scrollRef?: RefObject<HTMLDivElement>
  children: ReactNode
}

/** Shared scroll container + back control for entity detail pages. */
export default function DetailScrollBody({
  onBack,
  scrollRef,
  children
}: DetailScrollBodyProps): JSX.Element {
  return (
    <div className="scroll-body scroll-body--scroll" ref={scrollRef}>
      <div className="scroll-body-inner scroll-body-inner--detail">
        {onBack ? <BackButton onClick={onBack} /> : null}
        {children}
      </div>
    </div>
  )
}
