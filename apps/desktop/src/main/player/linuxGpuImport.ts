import fs from 'node:fs'
import path from 'node:path'
import { linuxPlaybackBackend } from './playbackDisplay'

interface StartupHost {
  isReady(): boolean
  commandLine: { hasSwitch(name: string): boolean; getSwitchValue(name: string): string; appendSwitch(name: string, value: string): void }
}
export function hasX11GpuRuntime(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(process.execPath), 'javdex-angle.json'), 'utf8'))
    return manifest.schemaVersion === 1 && manifest.electronVersion === process.versions.electron
      && manifest.x11RequestedVisual === true
  } catch { return false }
}

export function configureLinuxGpuImport(host: StartupHost, available = hasX11GpuRuntime()): void {
  if (!available || host.commandLine.hasSwitch('disable-gpu') || linuxPlaybackBackend() !== 'dmabuf'
    || host.commandLine.getSwitchValue('ozone-platform') !== 'x11') return
  if (host.isReady()) throw new Error('GPU 导入后端必须在应用启动时配置')
  const angle = host.commandLine.getSwitchValue('use-angle')
  if (angle && angle !== 'vulkan') return
  host.commandLine.appendSwitch('use-angle', 'vulkan')
  // Keep Skia on GLES through ANGLE. Chromium's separate Ganesh/Vulkan import
  // path has different external-image ownership/layout behavior.
  const disabled = new Set(host.commandLine.getSwitchValue('disable-features').split(',').filter(Boolean))
  disabled.add('Vulkan')
  host.commandLine.appendSwitch('disable-features', [...disabled].join(','))
}

export function linuxGpuImportLoader(host: StartupHost): string | undefined {
  return host.commandLine.getSwitchValue('ozone-platform') === 'x11'
    && host.commandLine.getSwitchValue('use-angle') === 'vulkan'
    ? path.join(path.dirname(process.execPath), 'libvulkan.so.1') : undefined
}
