import type { BrowserWindow } from 'electron'

type Direction = 'back' | 'forward'
interface NavigationWindow {
  isDestroyed(): boolean
  webContents: { navigationHistory: { canGoBack(): boolean; canGoForward(): boolean; goBack(): void; goForward(): void } }
}
interface KeyInput {
  type: string; key: string; code?: string; isAutoRepeat?: boolean; isComposing?: boolean
  shift?: boolean; control?: boolean; meta?: boolean; alt?: boolean
}
export function historyKey(input: KeyInput, platform: NodeJS.Platform): Direction | null {
  if (input.type !== 'keyDown' || input.isComposing || input.isAutoRepeat || input.shift || input.control) return null
  if (input.alt && !input.meta) {
    if (input.key === 'ArrowLeft') return 'back'
    if (input.key === 'ArrowRight') return 'forward'
  }
  if (platform === 'darwin' && input.meta && !input.alt) {
    if (input.key === '[' || input.code === 'BracketLeft') return 'back'
    if (input.key === ']' || input.code === 'BracketRight') return 'forward'
  }
  return null
}
export function navigateWindowHistory(window: NavigationWindow | null, direction: Direction): void {
  if (!window || window.isDestroyed()) return
  const history = window.webContents.navigationHistory
  if (direction === 'back' && history.canGoBack()) history.goBack()
  if (direction === 'forward' && history.canGoForward()) history.goForward()
}
const bound = new WeakSet<BrowserWindow>()
/** All entries traverse the real browser history; the renderer owns overlay/leave policy. */
export function bindWindowNavigation(window: BrowserWindow, platform = process.platform): void {
  if (bound.has(window)) return
  bound.add(window)
  window.webContents.on('before-input-event', (event, input) => {
    const direction = historyKey(input, platform)
    if (!direction) return
    event.preventDefault()
    navigateWindowHistory(window, direction)
  })
  window.on('app-command', (_event, command) => {
    if (command === 'browser-backward') navigateWindowHistory(window, 'back')
    else if (command === 'browser-forward') navigateWindowHistory(window, 'forward')
  })
  // Electron's macOS swipe event is the legacy OS gesture, not a promise that
  // every modern two-finger trackpad configuration emits it.
  window.on('swipe', (_event, direction) => {
    if (direction === 'right') navigateWindowHistory(window, 'back')
    else if (direction === 'left') navigateWindowHistory(window, 'forward')
  })
}
