import { useCallback, useEffect, useRef, useState } from 'react'

/** Track a DOM element's content box size via ResizeObserver. */
export function useElementSize<T extends HTMLElement>(): {
  ref: (node: T | null) => void
  width: number
  height: number
} {
  const [size, setSize] = useState({ width: 0, height: 0 })
  const observerRef = useRef<ResizeObserver | null>(null)

  const disconnect = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
  }, [])

  const ref = useCallback(
    (node: T | null) => {
      disconnect()
      if (!node) {
        setSize({ width: 0, height: 0 })
        return
      }

      const measure = (entry?: ResizeObserverEntry) => {
        const width = entry
          ? Math.floor(entry.contentRect.width)
          : Math.floor(node.getBoundingClientRect().width)
        const height = entry
          ? Math.floor(entry.contentRect.height)
          : Math.floor(node.getBoundingClientRect().height)
        setSize((prev) =>
          prev.width === width && prev.height === height ? prev : { width, height }
        )
      }

      measure()
      const ro = new ResizeObserver((entries) => {
        if (entries[0]) measure(entries[0])
      })
      ro.observe(node)
      observerRef.current = ro
    },
    [disconnect]
  )

  useEffect(() => disconnect, [disconnect])

  return { ref, width: size.width, height: size.height }
}
