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
const regionFocus = new WeakMap<Element, HTMLElement>()
function available(element: HTMLElement): boolean {
  const modal = document.querySelector('dialog[open]')
  return element.isConnected && !element.matches(':disabled') &&
    (!modal || modal.contains(element)) &&
    (!element.matches('[tabindex="-1"]') || element.hasAttribute('data-navigation-item')) &&
    !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === 'visible' &&
    (!document.fullscreenElement || document.fullscreenElement.contains(element))
}

/** Region > group > adjacent row/column > distance. Native editing keeps its keys. */
export function spatialNavigation(event: KeyboardEvent): void {
  // The image viewer owns arrows, zoom, Escape and its focus trap.
  if (document.querySelector('.image-preview')) return
  const active = document.activeElement as HTMLElement | null
  const editing = active?.matches('input, textarea, select') || active?.isContentEditable
  const modal = document.querySelector('dialog[open]')
  if (event.key === 'Tab' && modal && !event.defaultPrevented && !event.ctrlKey && !event.altKey && !event.metaKey) {
    const controls = Array.from(modal.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex="0"]')).filter(available)
    const first = controls[0]
    const last = controls.at(-1)
    if (first && last && (event.shiftKey ? active === first : active === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
    return
  }
  if (event.key === '/' && !editing && !event.defaultPrevented && !event.isComposing &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !document.fullscreenElement && !document.querySelector('dialog[open]')) {
    const search = document.getElementById('web-search') as HTMLInputElement | null
    if (search) {
      event.preventDefault()
      search.focus()
      search.select()
    }
    return
  }
  if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing &&
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !document.fullscreenElement) {
    // A modal owns Escape; the native dialog restores its opener's focus.
    if (document.querySelector('dialog[open]')) return
    const current = document.activeElement as HTMLElement | null
    const target = current?.dataset.keyboardExit
    if (target) {
      const destination = document.getElementById(target)
      if (destination) {
        event.preventDefault()
        destination.focus()
      }
    } else if (!editing) {
      const back = document.getElementById('detail-back') as HTMLButtonElement | null
      if (back) {
        event.preventDefault()
        back.click()
      }
    }
    return
  }
  if (
    !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229
  )
    return
  const current = document.activeElement as HTMLElement | null
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  if (
    !current ||
    current.matches('textarea, select') ||
    current.isContentEditable ||
    (horizontal && (
      (current instanceof HTMLInputElement && (current.value !== '' || current.validity.badInput)) ||
      current.closest('video')
    ))
  )
    return
  if (current === document.body || current === document.documentElement) {
    const first = Array.from(document.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, video[controls]'
    )).find(element => available(element) && !element.classList.contains('skip'))
    if (first) {
      event.preventDefault()
      first.focus()
    }
    return
  }
  // Suppress native volume changes even when no next focus target is available.
  if (current.closest('video') && !horizontal) event.preventDefault()
  const box = current.getBoundingClientRect()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const positive = event.key === 'ArrowDown' || event.key === 'ArrowRight'
  const region = current.closest('[data-navigation-region]')
  const currentRegion = region?.getAttribute('data-navigation-region')
  const group = current.closest('[data-navigation-group]')
  const choices: { element: HTMLElement; tier: number; forward: number; cross: number }[] = []
  for (const candidate of document.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input, select, video[controls]'
  )) {
    if (
      candidate === current || !available(candidate) || candidate.classList.contains('skip')
    )
      continue
    const candidateRegion = candidate.closest('[data-navigation-region]')?.getAttribute('data-navigation-region')
    // Vertical movement follows the page's columns, never diagonal shortcuts
    // between the sidebar and content. Horizontal arrows may cross columns.
    if (!horizontal && (
      (currentRegion === 'content' && candidateRegion === 'sidebar') ||
      (currentRegion === 'sidebar' && candidateRegion === 'content')
    )) continue
    const rect = candidate.getBoundingClientRect()
    const dx = rect.x + rect.width / 2 - x
    const dy = rect.y + rect.height / 2 - y
    const forward = (horizontal ? dx : dy) * (positive ? 1 : -1)
    if (forward <= 1) continue
    const sameRegion = candidate.closest('[data-navigation-region]') === region
    const sameGroup = Boolean(group && candidate.closest('[data-navigation-group]') === group)
    // Different control heights within a row do not create a vertical neighbor.
    if (!horizontal && (positive ? rect.top < box.bottom - 2 : rect.bottom > box.top + 2)) continue
    // Left/right never wrap to another row or jump between header and content.
    if (horizontal) {
      if (sameRegion && (rect.bottom <= box.top + 2 || rect.top >= box.bottom - 2)) continue
      if (!sameRegion && !(
        (currentRegion === 'content' && candidateRegion === 'sidebar' && !positive) ||
        (currentRegion === 'sidebar' && candidateRegion === 'content' && positive)
      )) continue
    }
    choices.push({ element: candidate, tier: sameGroup ? 0 : sameRegion ? 1 : 2,
      forward: horizontal ? forward : Math.max(0, positive ? rect.top - box.bottom : box.top - rect.bottom),
      cross: Math.abs(horizontal ? dy : dx) })
  }
  choices.sort((a, b) => a.tier - b.tier ||
    (!horizontal ? a.forward - b.forward || a.cross - b.cross
      : (a.forward + a.cross * 3) - (b.forward + b.cross * 3)))
  let best = choices[0]?.element
  const destinationRegion = best?.closest('[data-navigation-region]')
  if (horizontal && region && destinationRegion && region !== destinationRegion) {
    regionFocus.set(region, current)
    const remembered = regionFocus.get(destinationRegion)
    if (remembered && available(remembered)) best = remembered
  }
  if (best) {
    event.preventDefault()
    best.focus({ preventScroll: true })
    best.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  } else if (region || group) {
    event.preventDefault()
  }
}
