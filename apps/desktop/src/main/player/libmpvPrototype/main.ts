// Throwaway entry point: deliberately does not import appMain or the real catalog.
import { app, BrowserWindow, ipcMain, nativeImage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createRemotePlaybackFixture } from './remoteFixture'
import type { RemotePlaybackFixture, RemotePlaybackFixtureStats } from './remoteFixture'

interface Bounds { x: number; y: number; width: number; height: number }
interface NativeState {
  alive: boolean
  nativeFrames?: number
  loadedFiles?: number
  commandErrors?: number
  error?: string
  pause?: boolean
  duration?: number
  volume?: number
  'time-pos'?: number
  'hwdec-current'?: string
  'current-ao'?: string
  'audio-pts'?: number
  [key: string]: unknown
}
interface NativeBridge {
  create(handle: Buffer, bounds: Bounds): void
  setBounds(bounds: Bounds): void
  setVisible(visible: boolean): void
  command(args: string[]): void
  state(): NativeState
  render(): void
  capture(): { data: Buffer; width: number; height: number }
  destroy(): void
}
const root = process.env.JAVDEX_MPV_PROTOTYPE_ROOT
if (!root || !path.isAbsolute(root)) throw new Error('Use npm run prototype:libmpv from the repository root')
const output = path.join(root, 'out/libmpv-prototype')
const reportFile = path.join(output, 'smoke-report.json')
const sourceRoot = path.join(root, 'apps/desktop/src/main/player/libmpvPrototype')
const media = [path.join(output, 'h264-aac.mp4'), path.join(output, 'hevc-main10-aac.mkv')]
const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-libmpv-prototype-'))
fs.chmodSync(sessionRoot, 0o700)
app.setPath('userData', path.join(sessionRoot, 'electron'))
app.setName('Javdex libmpv prototype')
const loadNative = createRequire(path.join(output, 'main.cjs'))
const native = loadNative(path.join(output, 'nativeBridge.node')) as NativeBridge
let window: BrowserWindow | undefined
let fixture: RemotePlaybackFixture | undefined
let remoteStats: RemotePlaybackFixtureStats | undefined
let viewport: Bounds | undefined
let sourceId = 'local-h264'
let timer: NodeJS.Timeout | undefined
let renderTimer: NodeJS.Timeout | undefined
let polling = false
let quitting = false
let smokeRunning = false
let exitCode = 0
const pageUrl = pathToFileURL(path.join(sourceRoot, 'prototype.html')).href

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame?.url !== pageUrl) {
    throw new Error('Invalid prototype IPC sender')
  }
}
function validBounds(value: unknown): Bounds {
  if (!value || typeof value !== 'object') throw new Error('Invalid viewport')
  const result = value as Bounds
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (!Number.isFinite(result[key]) || result[key] < 0 || result[key] > 16_384) throw new Error('Invalid viewport dimensions')
  }
  if (result.width < 1 || result.height < 1) throw new Error('Empty viewport')
  return { x: result.x, y: result.y, width: result.width, height: result.height }
}
function load(id: unknown): void {
  if (typeof id !== 'string' || !['local-h264', 'remote-h264', 'local-hevc', 'remote-hevc'].includes(id)) {
    throw new Error('Unknown prototype source')
  }
  const index = id.endsWith('hevc') ? 1 : 0
  // Locator/grant stays in main and native code. Renderer only knows the source ID.
  const locator = id.startsWith('remote') ? fixture!.getSource(index).playbackHandle : media[index]
  native.command(['set', 'pause', 'yes'])
  native.command(['loadfile', locator])
  sourceId = id
}
function recreate(): void {
  if (!window || !viewport) throw new Error('Viewport not initialized')
  native.destroy()
  assert.equal(native.state().alive, false)
  native.create(window.getNativeWindowHandle(), viewport)
  load(sourceId)
}
function action(name: unknown, value: unknown): void {
  if (typeof name !== 'string') throw new Error('Invalid action')
  if (name === 'pause' && typeof value === 'boolean') native.command(['set', 'pause', value ? 'yes' : 'no'])
  else if (name === 'seek' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400) {
    native.command(['seek', String(value), 'absolute+exact'])
  } else if (name === 'relative-seek' && (value === -5 || value === 5)) native.command(['seek', String(value), 'relative+exact'])
  else if (name === 'volume' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) {
    native.command(['set', 'volume', String(value)])
  } else if (name === 'fullscreen') window?.setFullScreen(!window.isFullScreen())
  else if (name === 'exit-fullscreen') window?.setFullScreen(false)
  else if (name === 'reopen') recreate()
  else throw new Error('Unsupported prototype action')
}
ipcMain.handle('mpv-probe:initialize', (event, bounds: unknown) => {
  trusted(event); viewport = validBounds(bounds); recreate()
  if (process.argv.includes('--smoke') && !smokeRunning) {
    smokeRunning = true
    void smoke().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown failure'
      fs.writeFileSync(reportFile, JSON.stringify({ verdict: 'failed', message }, null, 2))
      console.error('PROTOTYPE SMOKE FAILED:', message)
      exitCode = 1
      app.quit()
    })
  }
})
ipcMain.handle('mpv-probe:bounds', (event, bounds: unknown) => {
  trusted(event); viewport = validBounds(bounds); native.setBounds(viewport)
})
ipcMain.handle('mpv-probe:source', (event, id: unknown) => { trusted(event); load(id) })
ipcMain.handle('mpv-probe:action', (event, name: unknown, value: unknown) => { trusted(event); action(name, value) })
ipcMain.handle('mpv-probe:overlay', (event, visible: unknown) => {
  trusted(event)
  if (typeof visible !== 'boolean') throw new Error('Invalid overlay visibility')
  native.setVisible(!visible)
})

async function poll(): Promise<void> {
  if (polling || !window || window.isDestroyed()) return
  polling = true
  try {
    remoteStats = await fixture!.stats()
    if (!window?.isDestroyed()) window?.webContents.send('mpv-probe:state', {
      ...native.state(), source: sourceId,
      remote: { requests: remoteStats.playRequests - remoteStats.startup.playRequests,
        rangeRequests: remoteStats.rangeRequests - remoteStats.startup.rangeRequests,
        bytesSent: remoteStats.mediaBytes - remoteStats.startup.mediaBytes }
    })
  } finally { polling = false }
}
async function until(predicate: (state: NativeState) => boolean, label: string, timeout = 15_000): Promise<NativeState> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const state = native.state()
    if (state.error) throw new Error(`${label}: ${state.error}`)
    if (predicate(state)) return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${label}; state=${JSON.stringify(native.state())}`)
}
function capture(name: string): { file: string; uniqueColors: number } {
  const { data, width, height } = native.capture()
  const colors = new Set<number>()
  for (let index = 0; index < data.length; index += 400) colors.add(data.readUInt32LE(index) & 0xffffff)
  assert.ok(colors.size > 20, 'Native framebuffer must contain a rendered test pattern, not a black placeholder')
  const file = path.join(output, `${name}.png`)
  fs.writeFileSync(file, nativeImage.createFromBitmap(data, { width, height }).toPNG())
  return { file, uniqueColors: colors.size }
}
async function smoke(): Promise<void> {
  fs.writeFileSync(reportFile, JSON.stringify({ verdict: 'running' }))
  const results: object[] = []
  await until((state) => (state.loadedFiles ?? 0) > 0 && (state.nativeFrames ?? 0) > 2, 'initial frame')
  for (const id of ['local-h264', 'remote-h264', 'local-hevc', 'remote-hevc']) {
    const previous = native.state().loadedFiles ?? 0
    load(id)
    await until((state) => (state.loadedFiles ?? 0) > previous && (state.duration ?? 0) > 10, `${id} loaded`)
    action('seek', 0)
    await until((state) => state.pause === true && (state['time-pos'] ?? 99) < 0.2, `${id} reset clock`)
    action('pause', false)
    await until((state) => state.pause === false && (state['time-pos'] ?? 0) > 1 && (state['time-pos'] ?? 99) < 5
      && (state['audio-pts'] ?? 0) > 0 && !!state['current-ao'], `${id} AV output`)
    const restarts = native.state().playbackRestarts as number
    action('seek', 10)
    await until((state) => Number(state.playbackRestarts) > restarts && Math.abs((state['time-pos'] ?? 0) - 10) < 0.5, `${id} exact seek`)
    action('pause', true)
    const paused = await until((state) => state.pause === true, `${id} pause`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const stable = native.state()
    assert.ok(Math.abs((stable['time-pos'] ?? 0) - (paused['time-pos'] ?? 0)) < 0.2, 'Paused clock should stop')
    action('volume', 23)
    await until((state) => state.volume === 23, `${id} volume`)
    results.push({ source: id, state: native.state(), snapshot: capture(id) })
  }
  window!.setSize(1100, 800)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const resized = native.state()
  async function fullscreenTransition(enabled: boolean): Promise<void> {
    const target = window!
    const event = enabled ? 'enter-full-screen' : 'leave-full-screen'
    await new Promise<void>((resolve, reject) => {
      const listener = (): void => { clearTimeout(timeout); resolve() }
      const timeout = setTimeout(() => {
        if (enabled) target.removeListener('enter-full-screen', listener)
        else target.removeListener('leave-full-screen', listener)
        reject(new Error(`Timeout: ${event}`))
      }, 10_000)
      if (enabled) target.once('enter-full-screen', listener)
      else target.once('leave-full-screen', listener)
      target.setFullScreen(enabled)
    })
  }
  await fullscreenTransition(true)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const fullscreen = native.state()
  assert.ok(Number(fullscreen.pixelWidth) > Number(resized.pixelWidth), 'Native viewport should grow in fullscreen')
  await fullscreenTransition(false)
  for (let i = 0; i < 3; i++) {
    recreate()
    await until((state) => (state.loadedFiles ?? 0) > 0 && (state.nativeFrames ?? 0) > 2, 'session recreation')
  }
  const traffic = await fixture!.stats()
  assert.equal(traffic.checks.bytesMatch, true)
  assert.ok(traffic.playRequests > traffic.startup.playRequests, 'Native player must request the remote source')
  assert.ok(traffic.rangeRequests > traffic.startup.rangeRequests, 'Native player must issue Range requests')
  assert.ok(traffic.mediaBytes > traffic.startup.mediaBytes, 'Remote server must deliver original media bytes')
  native.destroy()
  assert.equal(native.state().alive, false)
  await fixture!.close()
  const closed = await fixture!.stats()
  assert.equal(closed.activeRequests, 0)
  const report = { verdict: 'macOS native render prototype passed', results, resized, fullscreen,
    traffic, cleanup: { nativeAlive: native.state().alive, activeRequests: closed.activeRequests },
    limitations: ['No human-hearing assertion', 'No Windows/Linux/package acceptance', 'No arbitrary HTML/video compositing', 'No independent Node deployment acceptance'] }
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  console.log('PROTOTYPE SMOKE PASSED: local/remote H264+HEVC, native frame readback, AV clocks, seek, pause, volume, resize/fullscreen, recreate/cleanup')
  app.quit()
}
app.on('before-quit', (event) => {
  if (quitting) return
  event.preventDefault(); quitting = true
  if (timer) clearInterval(timer)
  if (renderTimer) clearInterval(renderTimer)
  native.destroy()
  void Promise.resolve(fixture?.close()).catch((error: unknown) => {
    console.error('Remote fixture cleanup failed:', error instanceof Error ? error.message : 'Unknown failure')
    exitCode = 1
  }).finally(() => app.exit(exitCode))
})
app.on('window-all-closed', () => app.quit())
void app.whenReady().then(async () => {
  fixture = await createRemotePlaybackFixture(sessionRoot, media)
  remoteStats = await fixture.stats()
  window = new BrowserWindow({ width: 1120, height: 780, minWidth: 900, minHeight: 560,
    title: 'Javdex · libmpv 原生渲染验证',
    webPreferences: { preload: path.join(sourceRoot, 'preload.cjs'), contextIsolation: true,
      nodeIntegration: false, sandbox: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault() })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.on('close', () => { if (timer) clearInterval(timer); if (renderTimer) clearInterval(renderTimer); native.destroy() })
  window.webContents.on('render-process-gone', () => { exitCode = 1; native.destroy(); app.quit() })
  await window.loadURL(pageUrl)
  renderTimer = setInterval(() => native.render(), 16)
  timer = setInterval(() => { void poll().catch(() => { exitCode = 1; app.quit() }) }, 200)
  console.log('Prototype ready; synthetic media only. Use the source selector for local/remote playback.')
}).catch((error: unknown) => {
  console.error('Prototype startup failed:', error instanceof Error ? error.message : 'Unknown failure')
  exitCode = 1
  app.quit()
})
