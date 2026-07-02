import { useEffect, useState } from 'react'

export interface LayoutSpacing {
  pagePadX: number
  cardAreaPadTop: number
  cardAreaPadBottom: number
}

const DEFAULT: LayoutSpacing = {
  pagePadX: 24,
  cardAreaPadTop: 18,
  cardAreaPadBottom: 30
}

function readPx(raw: string, fallback: number): number {
  const n = parseInt(raw.trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/** Reads spacing tokens from CSS variables (single source of truth in styles.css). */
export function useLayoutSpacing(): LayoutSpacing {
  const [spacing, setSpacing] = useState<LayoutSpacing>(DEFAULT)

  useEffect(() => {
    const root = getComputedStyle(document.documentElement)
    setSpacing({
      pagePadX: readPx(root.getPropertyValue('--page-pad-x'), DEFAULT.pagePadX),
      cardAreaPadTop: readPx(root.getPropertyValue('--card-area-pad-top'), DEFAULT.cardAreaPadTop),
      cardAreaPadBottom: readPx(
        root.getPropertyValue('--card-area-pad-bottom'),
        DEFAULT.cardAreaPadBottom
      )
    })
  }, [])

  return spacing
}
