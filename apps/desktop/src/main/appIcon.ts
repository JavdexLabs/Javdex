import { app, nativeImage, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

function resourceRoots(): string[] {
  return [
    process.resourcesPath,
    path.join(__dirname, '../../resources'),
    path.join(app.getAppPath(), 'resources'),
    path.join(process.cwd(), 'resources')
  ]
}

function buildRoots(): string[] {
  return [
    process.resourcesPath,
    path.join(__dirname, '../../build'),
    path.join(app.getAppPath(), 'build'),
    path.join(process.cwd(), 'build')
  ]
}

/** Absolute path to the master 1024 PNG, if present. */
export function resolveAppIconPath(): string | null {
  const names = ['icon.png']
  for (const root of resourceRoots()) {
    for (const name of names) {
      const candidate = path.join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Window / taskbar icon. Windows prefers multi-size .ico. */
export function resolveWindowIcon(): NativeImage | undefined {
  if (process.platform === 'win32') {
    for (const root of buildRoots()) {
      const ico = path.join(root, 'icon.ico')
      if (!existsSync(ico)) continue
      const image = nativeImage.createFromPath(ico)
      if (!image.isEmpty()) return image
    }
  }

  const png = resolveAppIconPath()
  if (!png) return undefined
  const image = nativeImage.createFromPath(png)
  return image.isEmpty() ? undefined : image
}

/** macOS dock icon; packaged builds should ship icon.icns via electron-builder. */
export function resolveDockIcon(): NativeImage | undefined {
  if (process.platform === 'darwin') {
    for (const root of buildRoots()) {
      const icns = path.join(root, 'icon.icns')
      if (!existsSync(icns)) continue
      const image = nativeImage.createFromPath(icns)
      if (!image.isEmpty()) return image
    }
  }
  return resolveWindowIcon()
}

export function applyAppIcons(): void {
  const dockIcon = resolveDockIcon()
  if (process.platform === 'darwin' && dockIcon) {
    app.dock?.setIcon(dockIcon)
  }
}
