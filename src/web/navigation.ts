import { useSyncExternalStore } from 'react'
const subscribe = (callback: () => void): (() => void) => {
  window.addEventListener('hashchange', callback)
  return () => window.removeEventListener('hashchange', callback)
}
export function useWebLocation(): { pathname: string; query: URLSearchParams } {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const url = new URL(hash.slice(1) || '/browse', window.location.origin)
  return { pathname: url.pathname, query: url.searchParams }
}
export function route(pathname: string, query = new URLSearchParams()): string {
  return `#${pathname}${query.size ? `?${query}` : ''}`
}
export function navigate(
  pathname: string,
  query = new URLSearchParams(),
  replace = false
): void {
  const hash = route(pathname, query)
  if (replace) {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  } else window.location.hash = hash
}
/** Directional focus for TV remotes; native text editing and player controls retain arrow keys. */
export function spatialNavigation(event: KeyboardEvent): void {
  if (
    !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return
  const current = document.activeElement as HTMLElement | null
  if (
    !current ||
    current.matches('input, textarea, select, video') ||
    current.closest('video')
  )
    return
  const box = current.getBoundingClientRect()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  const positive = event.key === 'ArrowDown' || event.key === 'ArrowRight'
  let best: HTMLElement | null = null
  let score = Infinity
  for (const candidate of document.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input, select, video[controls]'
  )) {
    if (
      candidate === current ||
      candidate.closest('[hidden]') ||
      candidate.getClientRects().length === 0
    )
      continue
    const rect = candidate.getBoundingClientRect()
    const dx = rect.x + rect.width / 2 - x
    const dy = rect.y + rect.height / 2 - y
    const forward = (horizontal ? dx : dy) * (positive ? 1 : -1)
    if (forward <= 1) continue
    const distance = forward + Math.abs(horizontal ? dy : dx) * 3
    if (distance < score) {
      best = candidate
      score = distance
    }
  }
  if (best) {
    event.preventDefault()
    best.focus()
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}
