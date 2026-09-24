export const HOME_GLOBAL_SEARCH_ID = 'home-global-search'

interface GlobalSearchShortcutEvent {
  metaKey: boolean
  ctrlKey: boolean
  key: string
}

interface HomeSearchElement {
  focus(): void
  select?(): void
}

interface HomeSearchDocument {
  getElementById(id: string): HomeSearchElement | null
}

export function isGlobalSearchShortcut(event: GlobalSearchShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
}

/** Wait for navigation and the Home page commit before moving keyboard focus. */
export function queueHomeGlobalSearchFocus(
  documentRoot: HomeSearchDocument,
  scheduleFrame: (callback: () => void) => unknown
): void {
  scheduleFrame(() => {
    scheduleFrame(() => {
      const input = documentRoot.getElementById(HOME_GLOBAL_SEARCH_ID)
      input?.focus()
      input?.select?.()
    })
  })
}
