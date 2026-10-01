import type { ReactNode, Ref } from 'react'
import ScrollToTopButton from './ScrollToTopButton'
import ScrollViewport from './ScrollViewport'
import ScrollRegion from './ScrollRegion'
import PageContent from './PageContent'

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
    <ScrollViewport
      ref={scrollRef}
      variant={variant}
      className={className}
    >
      {withInner ? (
        <PageContent className={innerClassName}>
          {children}
        </PageContent>
      ) : (
        children
      )}
    </ScrollViewport>
  )

  if (variant === 'scroll' || onScrollToTop) {
    return (
      <ScrollRegion>
        {body}
        {onScrollToTop ? (
          <ScrollToTopButton visible={Boolean(showScrollToTop)} onClick={onScrollToTop} />
        ) : null}
      </ScrollRegion>
    )
  }

  return body
}
