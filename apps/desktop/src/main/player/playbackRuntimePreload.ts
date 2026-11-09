import type { BrowserWindow } from 'electron'
import type { ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSettingsStore } from '../application/desktopPorts'
import { disposePlaybackHostPreload } from './playbackHostPreload'
import { cancelWindowsPlaybackInteropPreload } from './windowsPlaybackInterop'

/** One speculative load after the main UI has loaded and become visible.
 * Playback may consume the child; canceling UI scheduling must not kill it. */
export function schedulePlaybackRuntimePreload(getWindow: () => BrowserWindow | null, settings: DesktopSettingsStore,
  forceCpu: boolean, preload: (mode: 'gpu' | 'cpu') => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = process.platform !== 'win32', disposed = false, revision = 0
  let selected: 'gpu' | 'cpu' | undefined
  const window = stopped ? null : getWindow()
  // BrowserWindow.webContents is a native getter and throws after closed.
  // Cache its EventEmitter while alive so teardown never calls that getter.
  const contents = window && !window.isDestroyed() ? window.webContents : null
  const mode = (value: ThisComputerSettings): 'gpu' | 'cpu' | undefined => value.playerPreference === 'external' ? undefined
    : forceCpu || value.playbackRenderMode === 'cpu' ? 'cpu' : 'gpu'
  const detach = (): void => {
    clearTimeout(timer); timer = undefined
    window?.off('show', schedule)
    contents?.off('did-finish-load', schedule)
  }
  const stopScheduling = (): void => { stopped = true; revision++; detach() }
  const disposeUnused = (): void => {
    try { disposePlaybackHostPreload() }
    finally { cancelWindowsPlaybackInteropPreload() }
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    try { stopScheduling(); window?.off('closed', dispose) }
    finally { disposeUnused() }
  }
  const schedule = (): void => {
    if (stopped || timer || !window || window.isDestroyed() || !contents || contents.isDestroyed() || !window.isVisible() || contents.isLoadingMainFrame()) return
    timer = setTimeout(() => {
      timer = undefined
      if (stopped || window.isDestroyed() || contents.isDestroyed() || !window.isVisible()) return
      const request = revision
      void settings.read().then(value => {
        if (stopped || request !== revision || window.isDestroyed() || contents.isDestroyed() || !window.isVisible()) return
        selected = mode(value)
        stopScheduling()
        if (selected) preload(selected)
      }).catch(() => { if (!stopped && request === revision) stopScheduling() })
    }, 2000)
    timer.unref()
  }
  if (window && contents) {
    window.on('show', schedule); window.once('closed', dispose)
    contents.on('did-finish-load', schedule)
    schedule()
  }
  return {
    beginPlayback: stopScheduling,
    settingsChanged(value: ThisComputerSettings): void {
      revision++
      if (selected && mode(value) !== selected) { selected = undefined; disposeUnused() }
      if (!stopped) schedule()
    },
    dispose
  }
}
