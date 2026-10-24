import type { BrowserWindow } from 'electron'

/** Software Wayland can finish loading without painting a hidden window. */
export function bindMainWindowPresentation(window: BrowserWindow, startup: {
  canContinue(): boolean
  windowReady(): void
}, software = false): void {
  let shown = false
  const show = (): void => {
    if (shown || window.isDestroyed() || !startup.canContinue()) return
    shown = true
    window.show()
    startup.windowReady()
  }
  window.once('ready-to-show', show)
  // Loading succeeded, so the background can be shown even if the compositor
  // requires a mapped window before it will produce ready-to-show.
  if (software) window.webContents.once('did-finish-load', show)
}
