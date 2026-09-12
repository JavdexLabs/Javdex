import type { BrowserWindow, Event, Input, WebContents } from 'electron'
import { shouldBlockNfoExportShortcut } from '@shared/nfoExportForegroundGuard'

interface ForegroundExportController {
  readonly isForegroundBlocking: boolean
  readonly hasActivePlanOrTask: boolean
  dispose(): Promise<void>
}

/** Bind every main-window WebContents, including windows recreated on macOS. */
export function bindNfoExportWindowGuard(
  window: Pick<BrowserWindow, 'webContents' | 'on'>,
  controller: ForegroundExportController,
  allowWindowClose: () => boolean = () => false
): void {
  const webContents: Pick<WebContents, 'on' | 'once'> = window.webContents
  window.on('close', (event: Event) => {
    if (controller.isForegroundBlocking && !allowWindowClose()) event.preventDefault()
  })
  webContents.on('before-input-event', (event: Event, input: Input) => {
    if (!controller.hasActivePlanOrTask || input.type !== 'keyDown') return
    const navigationShortcut = shouldBlockNfoExportShortcut({
      key: input.key,
      altKey: input.alt,
      ctrlKey: input.control,
      metaKey: input.meta
    })
    if (!navigationShortcut) return
    if (controller.isForegroundBlocking) event.preventDefault()
    else void controller.dispose()
  })
  webContents.on('will-navigate', (event: Event) => {
    if (controller.isForegroundBlocking) event.preventDefault()
    else if (controller.hasActivePlanOrTask) void controller.dispose()
  })
  webContents.on('will-frame-navigate', (event: Event) => {
    if (controller.isForegroundBlocking) event.preventDefault()
    else if (controller.hasActivePlanOrTask) void controller.dispose()
  })
  webContents.on('did-start-navigation', () => {
    if (controller.hasActivePlanOrTask && !controller.isForegroundBlocking) {
      void controller.dispose()
    }
  })
  webContents.on('will-prevent-unload', (event: Event) => {
    // Electron uses preventDefault here to ignore the renderer's beforeunload veto.
    if (allowWindowClose()) event.preventDefault()
  })
  const dispose = (): void => { void controller.dispose() }
  webContents.once('render-process-gone', dispose)
  webContents.once('destroyed', dispose)
}
