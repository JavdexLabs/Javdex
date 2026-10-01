/** Portaled layers that must not count as an "outside" click for parent popovers. */
const DISMISS_EXEMPT_SELECTORS = ['[data-select-control-menu]'] as const

export function isDismissExemptPortaledTarget(target: Node | null): boolean {
  if (!(target instanceof Element)) return false
  return DISMISS_EXEMPT_SELECTORS.some((selector) => target.closest(selector))
}
