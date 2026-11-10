import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { HostResponse } from './playbackHostProtocol'

const code = transpileModule(readFileSync(new URL('./playbackHostPreload.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
function fixture(platform = 'win32') {
  let now = 0, nextTimer = 0
  const timers = new Map<number, () => void>()
  const children: Array<ReturnType<typeof child>> = []
  const launches: unknown[][] = []
  function child(pid: number) {
    let killed = false
    const emitter = new EventEmitter()
    return Object.assign(emitter, { pid, stderr: new EventEmitter(),
      killed: () => killed, kill() { killed = true; emitter.emit('exit', 0); return true },
      postMessage() { assert.fail('Preloading must never send a native create or media command') } })
  }
  const exports = {} as typeof import('./playbackHostPreload')
  runInNewContext(code, { exports, process: { platform }, performance: { now: () => now }, console,
    setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return { id, unref() {} } },
    clearTimeout(timer?: { id: number }) { if (timer) timers.delete(timer.id) },
    require(name: string) {
      if (name === 'node:path') return path
      assert.equal(name, 'electron')
      return { app: { getAppPath: () => '/fixture' }, utilityProcess: { fork(...args: unknown[]) {
        launches.push(args); const value = child(children.length + 100); children.push(value); return value
      } } }
    }
  })
  return { ...exports, children, launches, timers,
    elapse(ms: number) { now += ms }, expire() { for (const callback of [...timers.values()]) callback() },
    ready(index = 0) { children[index].emit('message', { type: 'ready' } satisfies HostResponse) } }
}
test('one module-only child survives idle time and is adopted exactly once after ready', () => {
  const f = fixture()
  f.preloadPlaybackHost('/fixture/playback.node', 'gpu'); f.preloadPlaybackHost('/fixture/playback.node', 'gpu')
  assert.equal(f.children.length, 1); assert.equal(f.children[0].listenerCount('message'), 1)
  f.ready(); assert.equal(f.timers.size, 0)
  f.elapse(120000)
  const adopted = f.takePreloadedPlaybackHost('/fixture/playback.node', 'gpu')!
  assert.equal(adopted.child, f.children[0]); assert.equal(adopted.ready, true)
  assert.equal(f.children[0].listenerCount('message'), 0)
  f.disposePlaybackHostPreload(); assert.equal(f.children[0].killed(), false, 'the consumer now owns the child')
  assert.equal(f.takePreloadedPlaybackHost('/fixture/playback.node', 'gpu'), undefined)
})
test('a child still loading can be consumed without losing its later ready message or retaining a preload timeout', () => {
  const f = fixture(); f.preloadPlaybackHost('/fixture/playback.node', 'cpu'); f.elapse(20000)
  const adopted = f.takePreloadedPlaybackHost('/fixture/playback.node', 'cpu')!
  assert.equal(adopted.ready, false); assert.equal(f.timers.size, 0)
  const received: HostResponse[] = []; adopted.child.on('message', value => received.push(value))
  f.ready(); assert.equal(received[0].type, 'ready'); assert.equal(f.children.length, 1)
})
test('a different mode or runtime retires the unused process instead of adopting an incompatible child', () => {
  const f = fixture(); f.preloadPlaybackHost('/fixture/playback.node', 'gpu'); f.ready()
  assert.equal(f.takePreloadedPlaybackHost('/fixture/playback.node', 'cpu'), undefined)
  assert.equal(f.children[0].killed(), true)
  f.preloadPlaybackHost('/fixture/playback.node', 'cpu')
  f.preloadPlaybackHost('/replacement/playback.node', 'cpu')
  assert.equal(f.children[1].killed(), true); assert.equal(f.children[2].killed(), false)
  f.disposePlaybackHostPreload(); assert.equal(f.children[2].killed(), true)
})
test('preload timeout and failure clean up silently without creating a replacement process', () => {
  for (const reason of ['timeout', 'failed', 'exit', 'error'] as const) {
    const f = fixture(); f.preloadPlaybackHost('/fixture/playback.node', 'gpu')
    if (reason === 'timeout') { f.elapse(60000); f.expire() }
    else if (reason === 'failed') f.children[0].emit('message', { type: 'failed' })
    else f.children[0].emit(reason, 1)
    assert.equal(f.takePreloadedPlaybackHost('/fixture/playback.node', 'gpu'), undefined)
    assert.equal(f.timers.size, 0); assert.equal(f.children.length, 1)
  }
})
test('late ready or handoff cannot bypass the preload deadline when main timers have been delayed', () => {
  for (const ready of [false, true]) {
    const f = fixture(); f.preloadPlaybackHost('/fixture/playback.node', 'gpu'); f.elapse(60001)
    if (ready) f.ready()
    assert.equal(f.takePreloadedPlaybackHost('/fixture/playback.node', 'gpu'), undefined)
    assert.equal(f.children[0].killed(), true)
  }
})
test('preloading is currently Windows-only', () => {
  for (const platform of ['darwin', 'linux']) {
    const f = fixture(platform); f.preloadPlaybackHost('/fixture/playback.node', 'gpu')
    assert.equal(f.children.length, 0)
  }
})
