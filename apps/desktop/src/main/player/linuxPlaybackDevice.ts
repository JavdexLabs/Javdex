import { app } from 'electron'
import { readdirSync, readFileSync } from 'node:fs'
import { linuxPlaybackBackend } from './playbackDisplay'
import { hasX11GpuRuntime } from './linuxGpuImport'

interface Device { active?: boolean; vendorId?: number; deviceId?: number }
interface RenderNode { path: string; vendorId: number; deviceId: number }

/** PCI identity, rather than renderD128 ordering, connects the two processes.
 * Ambiguous identical adapters require an explicit override. */
export function matchPlaybackRenderNode(devices: Device[], nodes: RenderNode[]): string | undefined {
  const active = devices.filter(device => device.active)
  if (active.length !== 1) return undefined
  const matches = nodes.filter(node => node.vendorId === active[0].vendorId && node.deviceId === active[0].deviceId)
  return matches.length === 1 ? matches[0].path : undefined
}

let selected: string | undefined
let importFailure: string | undefined
let requireGpuCompositing = false
export async function prepareLinuxPlaybackDevice(): Promise<void> {
  if (process.platform !== 'linux' || linuxPlaybackBackend() !== 'dmabuf') return
  selected = undefined
  importFailure = undefined
  requireGpuCompositing = false
  const x11 = app.commandLine.getSwitchValue('ozone-platform') === 'x11'
  // X11's DRI3/Pixmap fallback can accept a shared image but fail later in
  // Skia without rejecting drawImage(). Require the direct import path rather
  // than treating Canvas submissions (or black media pixels) as a health test.
  if (x11) importFailure = '当前 X11 图形路径未确认支持直接 DMA-BUF 导入，请选择自动或 CPU 兼容播放模式'
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    // Keep library startup and CPU playback available when a GPU query stalls.
    const info = await Promise.race([app.getGPUInfo(x11 ? 'complete' : 'basic'), new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('GPU capability query timed out')), 5000)
    })]) as {
      gpuDevice?: Device[]; auxAttributes?: { glWsExtensions?: string }
    }
    if (x11) {
      // On Linux Electron can return only the basic GPU record even for
      // 'complete' (gl=none, no glWsExtensions), unlike Chromium's browser CDP
      // SystemInfo. An absent extension list is not a negative capability list.
      // Only our version-matched ANGLE Vulkan runtime can use this alternative;
      // its helper still validates the exact device and importable modifiers.
      const extensions = info.auxAttributes?.glWsExtensions
      requireGpuCompositing = extensions === undefined && hasX11GpuRuntime()
        && app.commandLine.getSwitchValue('use-angle') === 'vulkan'
      const supported = extensions !== undefined
        ? extensions.split(/\s+/).includes('EGL_EXT_image_dma_buf_import')
        : requireGpuCompositing
      if (!supported) {
        console.warn('[playback] X11 direct DMA-BUF import unavailable; GPU playback disabled')
        return
      }
      importFailure = undefined
    }
    if (process.env.JAVDEX_DRM_RENDER_NODE || app.commandLine.getSwitchValue('render-node-override')) return
    const nodes: RenderNode[] = []
    for (const name of readdirSync('/sys/class/drm').filter(name => /^renderD\d+$/.test(name))) {
      try {
        const device = `/sys/class/drm/${name}/device`
        nodes.push({ path: `/dev/dri/${name}`, vendorId: Number(readFileSync(`${device}/vendor`, 'utf8').trim()),
          deviceId: Number(readFileSync(`${device}/device`, 'utf8').trim()) })
      } catch { /* An unplugged node must not prevent matching a live adapter. */ }
    }
    selected = matchPlaybackRenderNode(info.gpuDevice ?? [], nodes)
  } catch { /* Fail at playback creation, without breaking the library window. */ }
  finally { clearTimeout(timeout) }
}

export function linuxPlaybackRenderNode(): string {
  if (importFailure) throw new Error(importFailure)
  // The initial app-ready query precedes the first BrowserWindow/GPU context.
  // Check compositing when playback actually opens, not against that cold state.
  if (requireGpuCompositing && app.getGPUFeatureStatus().gpu_compositing !== 'enabled')
    throw new Error('当前 X11 GPU 合成不可用，请选择自动或 CPU 兼容播放模式')
  const node = process.env.JAVDEX_DRM_RENDER_NODE || app.commandLine.getSwitchValue('render-node-override') || selected
  if (!node || !/^\/dev\/dri\/renderD\d+$/.test(node)) throw new Error('无法确定共享纹理消费设备，请指定 JAVDEX_DRM_RENDER_NODE 后重新启动')
  return node
}

/** Chromium may report software compositing briefly after the first window
 * loads, even with a working Vulkan device. Wait before the synchronous factory
 * classifies that transient state as a permanent GPU initialization failure. */
export async function waitForLinuxPlaybackCompositing(): Promise<void> {
  if (process.platform !== 'linux' || !requireGpuCompositing || !app.isHardwareAccelerationEnabled()) return
  const deadline = Date.now() + 2000
  while (app.getGPUFeatureStatus().gpu_compositing !== 'enabled' && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  // Keep the existing strict factory check after timeout; Auto may recover in
  // CPU, while explicit GPU still fails instead of using an unsafe import path.
}
