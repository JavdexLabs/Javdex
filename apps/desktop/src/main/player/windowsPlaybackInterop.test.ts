import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./windowsPlaybackInterop.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
const file = '/fixture/playback-interop.node'
function fixture() {
  let now = 0, nextTimer = 0, mainBinds = 0, failBinding = false
  const timers = new Map<number, () => void>(), order: string[] = []
  const api = { acquire: () => Buffer.alloc(8), release() {} }
  const workers: FakeWorker[] = []
  class FakeWorker extends EventEmitter {
    private finish!: () => void
    private done = new Promise<void>(resolve => { this.finish = resolve })
    constructor(entry: string, options: { workerData: string }) {
      super(); assert.equal(path.basename(entry), 'playbackInteropWorker.js'); assert.equal(options.workerData, file)
      workers.push(this)
    }
    unref() {}
    terminate() { order.push('retire'); return this.done }
    finishRetirement() { this.finish(); this.emit('exit', 1) }
  }
  const exports = {} as typeof import('./windowsPlaybackInterop')
  runInNewContext(code, { exports, process: { platform: 'win32' }, performance: { now: () => now }, console,
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return { id, unref() {} } },
    clearTimeout(timer?: { id: number }) { if (timer) timers.delete(timer.id) },
    require(name: string) {
      if (name === 'electron') return { app: { getAppPath: () => '/fixture' } }
      if (name === 'node:path') return path
      if (name === 'node:worker_threads') return { Worker: FakeWorker }
      if (name === './playbackHostPreload') return { PLAYBACK_HOST_INITIALIZATION_TIMEOUT_MS: 60000 }
      assert.equal(name, 'node:module')
      return { createRequire: () => (name: string) => {
        assert.equal(name, file); mainBinds++; order.push('bind')
        if (failBinding) throw new Error('registration failed')
        return api
      } }
    }
  })
  return { ...exports, workers, order, api, mainBinds: () => mainBinds,
    elapse(ms: number) { now += ms }, expire() { for (const callback of [...timers.values()]) callback() }, failBinding() { failBinding = true } }
}

test('preload and first play share one worker; main binds while its DLL reference is held', async () => {
  const f = fixture(); f.preloadWindowsPlaybackInterop(file)
  const ready = f.loadWindowsPlaybackInterop(file)
  assert.equal(f.loadWindowsPlaybackInterop(file), ready)
  assert.equal(f.workers.length, 1); assert.equal(f.mainBinds(), 0)
  f.workers[0].emit('message', 'ready')
  assert.equal(await ready, f.api)
  assert.deepEqual(f.order, ['bind', 'retire'])
  f.workers[0].finishRetirement(); f.disposeWindowsPlaybackInterop()
  assert.equal(f.getWindowsPlaybackInterop(file), f.api)
  assert.equal(await f.loadWindowsPlaybackInterop(file), f.api)
  assert.equal(f.workers.length, 1); assert.equal(f.mainBinds(), 1)
})

test('an actual play claims its own initialization budget and survives speculative cancellation', async () => {
  const f = fixture(); f.preloadWindowsPlaybackInterop(file); f.elapse(59000)
  const ready = f.loadWindowsPlaybackInterop(file)
  f.cancelWindowsPlaybackInteropPreload(); f.elapse(2000)
  f.workers[0].emit('message', 'ready')
  assert.equal(await ready, f.api); f.workers[0].finishRetirement()
})

test('cancelled warmup cannot bind late or create a second worker before retirement', async () => {
  const f = fixture(); f.preloadWindowsPlaybackInterop(file)
  f.cancelWindowsPlaybackInteropPreload()
  f.workers[0].emit('message', 'ready'); assert.equal(f.mainBinds(), 0)
  const ready = f.loadWindowsPlaybackInterop(file); assert.equal(f.workers.length, 1)
  f.workers[0].finishRetirement(); await new Promise(setImmediate)
  assert.equal(f.workers.length, 2)
  f.workers[1].emit('message', 'ready'); assert.equal(await ready, f.api)
  f.workers[1].finishRetirement()
})

for (const reason of ['worker-load-failed', 'worker-exited', 'module-load-timeout', 'main-binding-failed', 'cancelled'] as const) {
  test(`foreground interop reports ${reason} without caching unusable exports`, async () => {
    const f = fixture(), ready = f.loadWindowsPlaybackInterop(file)
    const failed = assert.rejects(ready, new RegExp(reason))
    const worker = f.workers[0]
    if (reason === 'worker-load-failed') worker.emit('error', new Error('load failure'))
    if (reason === 'worker-exited') worker.finishRetirement()
    if (reason === 'module-load-timeout') { f.elapse(60001); worker.emit('message', 'ready') }
    if (reason === 'main-binding-failed') { f.failBinding(); worker.emit('message', 'ready') }
    if (reason === 'cancelled') f.disposeWindowsPlaybackInterop()
    await failed
    assert.equal(f.getWindowsPlaybackInterop(file), undefined)
    worker.emit('message', 'ready'); worker.finishRetirement()
    assert.equal(f.mainBinds(), reason === 'main-binding-failed' ? 1 : 0)
  })
}
