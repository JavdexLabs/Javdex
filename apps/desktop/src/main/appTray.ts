import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { APP_DISPLAY_NAME } from '@shared/appIdentity'
import { resolveWindowIcon } from './appIcon'

let tray: Tray | null = null
let showWindow: (() => void) | null = null

function trayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    // Monochrome play mark with transparent padding; macOS adapts template contrast.
    const pixels = Buffer.alloc(32 * 32 * 4)
    for (let y = 6; y < 26; y++) {
      for (let x = 9; x < 9 + (10 - Math.abs(y - 15.5)) * 1.5; x++) {
        pixels[(y * 32 + x) * 4 + 3] = 255
      }
    }
    const icon = nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 2 })
    icon.setTemplateImage(true)
    return icon
  }
  const icon = resolveWindowIcon()
  if (!icon) throw new Error('无法加载系统托盘图标，请重新安装应用后再试')
  return process.platform === 'win32' ? icon : icon.resize({ width: 24, height: 24 })
}

export function initializeAppTray(onShowWindow: () => void): void {
  showWindow = onShowWindow
}

/** Create before accepting the setting, so an unavailable tray never strands a hidden window. */
export function setCloseToTrayEnabled(enabled: boolean): void {
  if (!enabled) {
    if (tray) showWindow?.()
    destroyAppTray()
    return
  }
  if (tray && !tray.isDestroyed()) return
  if (!showWindow) throw new Error('应用尚未就绪，请稍后重试')
  const next = new Tray(trayIcon())
  try {
    next.setToolTip(APP_DISPLAY_NAME)
    next.setContextMenu(Menu.buildFromTemplate([
      { label: '打开主窗口', click: () => showWindow?.() },
      { type: 'separator' },
      { label: `退出 ${APP_DISPLAY_NAME}`, click: () => app.quit() }
    ]))
    next.on('click', () => showWindow?.())
    next.on('double-click', () => showWindow?.())
    tray = next
  } catch (error) {
    next.destroy()
    throw error
  }
}

export function hasAppTray(): boolean {
  return tray !== null && !tray.isDestroyed()
}

export function destroyAppTray(): void {
  tray?.destroy()
  tray = null
}
