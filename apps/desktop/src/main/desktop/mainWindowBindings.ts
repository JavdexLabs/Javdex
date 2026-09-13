export interface BoundMainWindow {
  isDestroyed(): boolean
}

type MainWindowBinder = (window: BoundMainWindow) => void

const binders = new Set<MainWindowBinder>()

export function registerMainWindowBinder(binder: MainWindowBinder): () => void {
  binders.add(binder)
  return () => {
    binders.delete(binder)
  }
}

/** Bind every registered foreground listener. Safe to call again for a recreated window. */
export function bindMainWindow(window: BoundMainWindow | null | undefined): void {
  if (!window || window.isDestroyed()) return
  for (const binder of binders) binder(window)
}
