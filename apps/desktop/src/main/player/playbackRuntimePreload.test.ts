import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { BrowserWindow } from 'electron'
import type { ThisComputerSettings } from '@shared/desktop/settings'
import type { DesktopSettingsStore } from '../application/desktopPorts'

const code = transpileModule(readFileSync(new URL('./playbackRuntimePreload.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
function fixture(options: { platform?: string; visible?: boolean; loading?: boolean; forceCpu?: boolean; preference?: 'external' | 'builtin'; mode?: 'cpu' | 'auto' | 'gpu'; deferRead?: boolean; destroyed?: boolean } = {}) {
  let visible = options.visible ?? true, loading = options.loading ?? false, destroyed = options.destroyed ?? false
  let disposed = 0, readCount = 0, nextTimer = 0
  const selected: string[] = [], timers = new Map<number, () => void>()
  const value = { playerPreference: options.preference ?? 'builtin', playbackRenderMode: options.mode ?? 'auto' } as ThisComputerSettings
  let resolveRead!: (value: ThisComputerSettings) => void
  const delayed = new Promise<ThisComputerSettings>(resolve => { resolveRead = resolve })
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, isLoadingMainFrame: () => loading })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => destroyed, isVisible: () => visible })
  // Electron's native getter throws in closed, even though EventEmitter off()
  // still works on the cached wrappers. Model that boundary, not a plain field.
  Object.defineProperty(window, 'webContents', { get() {
    if (destroyed) throw new TypeError('Object has been destroyed')
    return contents
  } })
  const exports = {} as typeof import('./playbackRuntimePreload')
  runInNewContext(code, { exports, process: { platform: options.platform ?? 'win32' },
    setTimeout(callback: () => void, ms: number) { assert.equal(ms, 2000); const id = ++nextTimer; timers.set(id, callback); return { id, unref() {} } },
    clearTimeout(timer?: { id: number }) { if (timer) timers.delete(timer.id) },
    require(name: string) {
      if (name === './windowsPlaybackInterop') return { cancelWindowsPlaybackInteropPreload() {} }
      assert.equal(name, './playbackHostPreload'); return { disposePlaybackHostPreload() { disposed++ } }
    }
  })
  const settings = { read: async () => { readCount++; return options.deferRead ? delayed : value } } as DesktopSettingsStore
  const control = exports.schedulePlaybackRuntimePreload(() => window as unknown as BrowserWindow, settings, options.forceCpu ?? false, mode => selected.push(mode))
  return { control, selected, timers, contents, window, value, reads: () => readCount, disposals: () => disposed,
    show() { visible = true; window.emit('show') }, loaded() { loading = false; contents.emit('did-finish-load') },
    close() { destroyed = true; window.emit('closed') }, resolveRead() { resolveRead(value) },
    async tick() { for (const [id, callback] of [...timers]) { timers.delete(id); callback() }; await new Promise(setImmediate) }
  }
}
test('preload waits for a visible, loaded UI and a deferred turn, then runs only once', async () => {
  const f = fixture({ visible: false, loading: true })
  assert.equal(f.timers.size, 0); f.show(); assert.equal(f.timers.size, 0)
  f.loaded(); assert.equal(f.selected.length, 0); assert.equal(f.timers.size, 1)
  await f.tick(); assert.deepEqual(f.selected, ['gpu'])
  f.show(); f.loaded(); await f.tick(); assert.equal(f.selected.length, 1)
  f.close(); assert.equal(f.disposals(), 1)
})
test('preload honors CPU selection, software-startup override and external-player preference', async () => {
  for (const [options, expected] of [
    [{ mode: 'cpu' }, ['cpu']], [{ forceCpu: true }, ['cpu']], [{ mode: 'gpu' }, ['gpu']], [{ preference: 'external' }, []]
  ] as const) {
    const f = fixture(options); await f.tick(); assert.deepEqual(f.selected, expected); f.control.dispose()
  }
})
test('playing early cancels queued or in-flight scheduling without killing a child awaiting adoption', async () => {
  const queued = fixture(); queued.control.beginPlayback(); await queued.tick()
  assert.equal(queued.reads(), 0); assert.equal(queued.disposals(), 0)
  const pending = fixture({ deferRead: true }); await pending.tick(); assert.equal(pending.reads(), 1)
  pending.control.beginPlayback(); pending.resolveRead(); await new Promise(setImmediate)
  assert.equal(pending.selected.length, 0); assert.equal(pending.disposals(), 0)
  const ready = fixture(); await ready.tick(); ready.control.beginPlayback()
  assert.equal(ready.disposals(), 0); ready.control.dispose(); assert.equal(ready.disposals(), 1)
})
test('mode changes cancel unused preloaded state but unrelated settings do not', async () => {
  const f = fixture(); await f.tick()
  f.control.settingsChanged({ ...f.value, playbackVolume: 30 }); assert.equal(f.disposals(), 0)
  f.control.settingsChanged({ ...f.value, playbackRenderMode: 'cpu' }); assert.equal(f.disposals(), 1)
  await f.tick(); assert.equal(f.selected.length, 1, 'background preload is attempted once per launch')
})
test('shutdown or window closure prevents a pending settings read from launching a child', async () => {
  for (const close of [false, true]) {
    const f = fixture({ deferRead: true }); await f.tick()
    if (close) f.close(); else f.control.dispose()
    f.resolveRead(); await new Promise(setImmediate)
    assert.equal(f.selected.length, 0); assert.equal(f.timers.size, 0)
  }
})
test('Mac and Linux do not schedule this Windows-specific warmup', async () => {
  for (const platform of ['darwin', 'linux']) {
    const f = fixture({ platform }); await f.tick(); assert.equal(f.reads(), 0); assert.equal(f.selected.length, 0)
  }
})

for (const phase of ['queued', 'reading-settings', 'preloaded', 'playback-started'] as const) test(`native window destruction is safe during ${phase} and cleanup is idempotent`, async () => {
  const f = fixture({ deferRead: phase === 'reading-settings' })
  if (phase === 'reading-settings' || phase === 'preloaded' || phase === 'playback-started') await f.tick()
  if (phase === 'playback-started') f.control.beginPlayback()
  assert.doesNotThrow(() => f.close())
  assert.doesNotThrow(() => f.control.dispose())
  assert.doesNotThrow(() => f.control.dispose())
  assert.equal(f.disposals(), 1)
  assert.equal(f.contents.listenerCount('did-finish-load'), 0)
  assert.equal(f.window.listenerCount('show'), 0)
  assert.equal(f.window.listenerCount('closed'), 0)
  const count = f.selected.length
  f.resolveRead(); await f.tick(); assert.equal(f.selected.length, count)
})

test('an already destroyed main window is not inspected or scheduled', async () => {
  const f = fixture({ destroyed: true })
  await f.tick(); assert.equal(f.reads(), 0)
  assert.doesNotThrow(() => f.control.dispose())
})
