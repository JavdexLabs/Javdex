import type { ReactNode, Ref } from 'react'
import ScrollToTopButton from './ScrollToTopButton'

interface ListSurfaceProps {
  variant: 'fill' | 'scroll'
  children: ReactNode
  scrollRef?: Ref<HTMLDivElement>
  withInner?: boolean
  className?: string
  innerClassName?: string
  showScrollToTop?: boolean
  onScrollToTop?: () => void
}

export default function ListSurface({
  variant,
  children,
  scrollRef,
  withInner = variant === 'scroll',
  className = '',
  innerClassName = '',
  showScrollToTop,
  onScrollToTop
}: ListSurfaceProps): JSX.Element {
  const body = (
    <div
      ref={scrollRef}
      className={`scroll-body scroll-body--${variant}${className ? ` ${className}` : ''}`}
    >
      {withInner ? (
        <div className={`scroll-body-inner${innerClassName ? ` ${innerClassName}` : ''}`}>
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )

  if (variant === 'scroll' || onScrollToTop) {
    return (
      <div className="list-scroll-region">
        {body}
        {onScrollToTop ? (
          <ScrollToTopButton visible={Boolean(showScrollToTop)} onClick={onScrollToTop} />
        ) : null}
      </div>
    )
  }

  return body
}
