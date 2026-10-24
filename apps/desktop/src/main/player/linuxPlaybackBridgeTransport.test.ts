import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { graphicsPlaybackFailure } from './playbackGraphicsFailure'

const code = transpileModule(readFileSync(new URL('./linuxPlaybackBridge.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText
function fixture(backend: 'dmabuf' | 'software', cleanupFailure = false) {
  let brokenWrite = false
  const timeouts: Array<() => void> = []
  const stdin = Object.assign(new EventEmitter(), { writable: true, writableLength: 0,
    write() { if (brokenWrite) throw new Error('closed pipe'); return true }, end() {} })
  const child = Object.assign(new EventEmitter(), { stdin, stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stderr: new EventEmitter(), killed: false, kill() { child.killed = true; return true } })
  const exports = {} as typeof import('./linuxPlaybackBridge')
  runInNewContext(code, { exports, Buffer, process: { env: {} }, Date, console,
    setInterval: () => ({ unref() {} }), clearInterval() {},
    setTimeout: (callback: () => void) => { timeouts.push(callback); return { unref() {} } }, clearTimeout() {},
    require(id: string) {
      if (id === 'node:fs') return { existsSync: () => false }
      if (id === 'node:path') return path
      if (id === 'node:diagnostics_channel') return { channel: () => ({ subscribe() {}, unsubscribe() {} }) }
      if (id === 'node:child_process') return { spawn: () => child }
      if (id === './playbackGraphicsFailure') return { graphicsPlaybackFailure }
      throw new Error(id)
    }
  })
  const bridge = exports.createLinuxPlaybackBridge('/fixture/helper', () => ({
    surfaceToken: 'fixture', childFd: 11, spawned() {}, destroy() { if (cleanupFailure) throw new Error('frame cleanup failed') }, setVisible() {}
  }), undefined, undefined, backend)
  bridge.create({ x: 0, y: 0, width: 1, height: 1 })
  return { bridge, child, timeouts, breakWrite: () => { brokenWrite = true } }
}

test('Linux frame cleanup faults cannot strand a helper on destroy or escape its exit event', () => {
  for (const operation of ['destroy', 'exit'] as const) {
    const f = fixture('dmabuf', true)
    assert.doesNotThrow(() => operation === 'destroy' ? f.bridge.destroy() : f.child.emit('exit', 1))
    if (operation === 'exit') assert.throws(() => f.bridge.state(), { playbackFailureCode: 'PLAYBACK_HOST_EXITED' })
    else { for (const timeout of f.timeouts) timeout(); assert.equal(f.child.killed, true) }
    f.bridge.destroy()
  }
})

for (const backend of ['dmabuf', 'software'] as const)
  for (const cause of ['killed', 'closed', 'backpressure', 'write'] as const)
    test(`Linux ${backend}: ${cause} transport failure retains a terminal snapshot`, t => {
      const f = fixture(backend); t.after(f.bridge.destroy)
      if (cause === 'killed') f.child.killed = true
      if (cause === 'closed') f.child.stdin.writable = false
      if (cause === 'backpressure') f.child.stdin.writableLength = 9 * 1024 * 1024
      if (cause === 'write') f.breakWrite()
      const expected = backend === 'dmabuf' ? { playbackFailureKind: 'graphics' } : /CPU/
      assert.throws(() => f.bridge.command(['set', 'pause', 'yes']), expected)
      assert.throws(() => f.bridge.inspect(), expected)
    })

test('invalid control arguments are not classified as GPU faults', t => {
  const f = fixture('dmabuf'); t.after(f.bridge.destroy)
  assert.throws(() => f.bridge.command(['invalid\0argument']), /无效/)
  assert.equal(f.bridge.inspect().alive, true)
})
