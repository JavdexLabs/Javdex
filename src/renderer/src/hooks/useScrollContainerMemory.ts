import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { SCROLL_TO_TOP_THRESHOLD } from '../components/ScrollToTopButton'
import { resolveScrollTopForKey, setListScroll } from '../listView/listViewMemory'

export interface ScrollContainerMemory {
  ref: RefObject<HTMLDivElement>
  showScrollToTop: boolean
  scrollToTop: () => void
}

/** Restore / persist scrollTop for non-virtual scroll containers. */
export function useScrollContainerMemory(memoryKey: string): ScrollContainerMemory {
  const ref = useRef<HTMLDivElement>(null)
  const prevMemoryKeyRef = useRef<string | undefined>(undefined)
  const [showScrollToTop, setShowScrollToTop] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !memoryKey) return
    const scrollTop = resolveScrollTopForKey(prevMemoryKeyRef.current, memoryKey)
    prevMemoryKeyRef.current = memoryKey
    el.scrollTop = scrollTop
    setShowScrollToTop(scrollTop > SCROLL_TO_TOP_THRESHOLD)
  }, [memoryKey])

  useEffect(() => {
    const el = ref.current
    if (!el || !memoryKey) return
    const onScroll = (): void => {
      const { scrollTop } = el
      setListScroll(memoryKey, { scrollTop })
      setShowScrollToTop((prev) => {
        const next = scrollTop > SCROLL_TO_TOP_THRESHOLD
        return prev === next ? prev : next
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [memoryKey])

  const scrollToTop = useCallback((): void => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: 0, behavior: 'smooth' })
    if (memoryKey) {
      setListScroll(memoryKey, { scrollTop: 0, visibleRowIndex: 0 })
    }
    setShowScrollToTop(false)
  }, [memoryKey])

  return { ref, showScrollToTop, scrollToTop }
}
