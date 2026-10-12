import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { interactionLayers, preservedInteractionSurfaceSelector, type InteractionLayer } from './interactionLayers'

export const InteractionLayerOwner = createContext<{ id: string; depth: number } | undefined>(undefined)

let locks = 0
let previousOverflow = ''
const inerted = new Map<HTMLElement, boolean>()
let backgroundObserver: MutationObserver | null = null

function syncBackground(): void {
  for (const [element, previous] of inerted) element.inert = previous
  inerted.clear()
  const modalRoots = interactionLayers.modalRoots()
  if (!modalRoots.length) { backgroundObserver?.disconnect(); backgroundObserver = null; return }
  // Preserved feedback surfaces remain clickable above a modal, without owning
  // dismissal, scroll locks, or focus. Include ancestors when walking the body.
  const roots = [...modalRoots, ...document.querySelectorAll<HTMLElement>(preservedInteractionSurfaceSelector)]
  if (!backgroundObserver && typeof MutationObserver !== 'undefined') {
    backgroundObserver = new MutationObserver(records => {
      if (records.some(record => record.type === 'attributes'
        || [...record.addedNodes, ...record.removedNodes].some(node => node instanceof HTMLElement))) syncBackground()
    })
    backgroundObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-interaction-preserve-surface'] })
  }
  // Walk around the active modal and its portaled descendants, without hiding them.
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue
      if (roots.includes(child)) continue
      if (roots.some(root => child.contains(root))) visit(child)
      else { inerted.set(child, child.inert); child.inert = true }
    }
  }
  visit(document.body)
}

export function useInteractionLayer({
  enabled = true, rootRef, anchorRef, modal = false, onDismiss, blockShortcut
}: {
  enabled?: boolean
  rootRef?: RefObject<HTMLElement | null>
  anchorRef?: RefObject<HTMLElement | null>
  modal?: boolean
  onDismiss?: () => void
  blockShortcut?: (event: KeyboardEvent) => boolean
}) {
  const id = useId()
  const parent = useContext(InteractionLayerOwner)
  const parentId = parent?.id
  const depth = (parent?.depth ?? 0) + 1
  const current = useRef({ onDismiss, blockShortcut })
  current.current = { onDismiss, blockShortcut }
  // Capture before child autoFocus, not in the mounting effect.
  const returnFocus = useRef(typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null)
  const previousEnabled = useRef(false)
  if (enabled && !previousEnabled.current && typeof document !== 'undefined') returnFocus.current = document.activeElement as HTMLElement | null
  previousEnabled.current = enabled
  useLayoutEffect(() => {
    if (!enabled || typeof document === 'undefined' || typeof window.addEventListener !== 'function') return
    const anchor = anchorRef?.current
    // Positioning anchors may be non-focusable wrappers around the actual button.
    const previousFocus = anchor && anchor.tabIndex >= 0 ? anchor : returnFocus.current
    const layer: InteractionLayer = {
      id, parentId, modal, root: () => rootRef?.current ?? null,
      anchor: () => anchorRef?.current ?? null,
      dismiss: () => current.current.onDismiss?.(),
      blockShortcut: event => Boolean(current.current.blockShortcut?.(event))
    }
    const unregister = interactionLayers.register(layer)
    if (modal && locks++ === 0) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    const onKey = (event: KeyboardEvent) => {
      if (interactionLayers.isTop(id)) interactionLayers.handleKey(event)
    }
    window.addEventListener('keydown', onKey)
    const onCapture = (event: KeyboardEvent) => {
      if (interactionLayers.isTop(id) && interactionLayers.blocksShortcut(event)) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    window.addEventListener('keydown', onCapture, true)
    // Test renderers have no DOM; the browser adapter starts once refs are attached.
    if (rootRef?.current) {
      syncBackground()
      if (modal && interactionLayers.isTop(id)) rootRef.current.focus()
    }
    return () => {
      const wasTop = interactionLayers.isTop(id)
      const focused = document.activeElement
      // Blur/Tab may already have moved focus elsewhere; only restore an abandoned layer.
      const restoreFocus = modal || focused === document.body || !focused || layer.root()?.contains(focused)
      unregister()
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onCapture, true)
      if (modal && --locks === 0) document.body.style.overflow = previousOverflow
      if (typeof HTMLElement !== 'undefined') syncBackground()
      if (wasTop && restoreFocus && previousFocus?.isConnected && !previousFocus.matches(':disabled') && !previousFocus.closest('[inert]')) previousFocus.focus()
    }
  }, [enabled, id, parentId, modal, rootRef, anchorRef])
  return useMemo(() => ({
    id,
    owner: { id, depth },
    style: { zIndex: `calc(var(--layer-overlay, 900) + ${depth} * var(--layer-step, 100))` },
    isTop: () => interactionLayers.isTop(id),
    contains: (target: Node) => interactionLayers.contains(id, target)
  }), [depth, id])
}
