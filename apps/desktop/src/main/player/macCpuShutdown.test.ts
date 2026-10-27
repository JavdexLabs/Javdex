import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import type { WebContents } from 'electron'

const code = transpileModule(readFileSync(new URL('./macCpuShutdown.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const surface = 'cpu:11111111-1111-4111-8111-111111111111'

function fixture(options: { destroyed?: boolean; sendFails?: boolean } = {}) {
  const ipc = new EventEmitter(), timers = new Map<number, () => void>()
  const messages: Array<{ channel: string; value: { requestId: string; surfaceToken: string } }> = []
  let nextTimer = 0, nextRequest = 0
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => options.destroyed === true,
    send(channel: string, value: { requestId: string; surfaceToken: string }) {
      if (options.sendFails) throw new Error('renderer unavailable')
      messages.push({ channel, value })
    }
  })
  const exports = {} as typeof import('./macCpuShutdown')
  runInNewContext(code, { exports,
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout: (id: number) => { timers.delete(id) },
    require(id: string) {
      if (id === 'electron') return { ipcMain: ipc }
      if (id === 'node:crypto') return { randomUUID: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++nextRequest).padStart(12, '0')}` }
      throw new Error(id)
    }
  })
  const start = (token = surface) => exports.retireMacCpuSurface(contents as unknown as WebContents, token)
  const reply = (value: unknown, sender: unknown = contents, senderFrame: unknown = contents.mainFrame): void => {
    ipc.emit('playback:cpu-shutdown-ready', { sender, senderFrame }, value)
  }
  return { contents, ipc, timers, messages, start, reply }
}

test('Mac CPU shutdown only accepts the current surface and request from its owning main frame', async () => {
  const f = fixture(), pending = f.start()
  let done = false
  void pending.then(() => { done = true })
  assert.equal(f.messages[0].channel, 'playback:cpu-shutdown')
  const request = f.messages[0].value
  f.reply(request, {})
  f.reply(request, f.contents, {})
  f.reply(request, f.contents, null)
  f.reply({ ...request, requestId: 'stale' })
  f.reply({ ...request, surfaceToken: 'cpu:22222222-2222-4222-8222-222222222222' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(done, false)
  f.reply(request); await pending
  assert.equal(done, true)
  assert.equal(f.ipc.listenerCount('playback:cpu-shutdown-ready'), 0)
  assert.equal(f.contents.listenerCount('destroyed'), 0)
  assert.equal(f.contents.listenerCount('render-process-gone'), 0)
  assert.equal(f.timers.size, 0)
})

test('Mac CPU shutdown bounds a missing reply and cleans up if the renderer disappears', async () => {
  for (const event of ['timeout', 'destroyed', 'render-process-gone'] as const) {
    const f = fixture(), pending = f.start()
    if (event === 'timeout') f.timers.values().next().value!()
    else f.contents.emit(event)
    await pending
    assert.equal(f.ipc.listenerCount('playback:cpu-shutdown-ready'), 0)
    assert.equal(f.contents.listenerCount('destroyed'), 0)
    assert.equal(f.contents.listenerCount('render-process-gone'), 0)
    assert.equal(f.timers.size, 0)
  }
})

test('Mac CPU shutdown skips unavailable or non-CPU surfaces and tolerates a failed send', async () => {
  for (const [options, token] of [[{ destroyed: true }, surface], [{}, 'gpu-surface'], [{ sendFails: true }, surface]] as const) {
    const f = fixture(options)
    await f.start(token)
    assert.equal(f.ipc.listenerCount('playback:cpu-shutdown-ready'), 0)
    assert.equal(f.timers.size, 0)
    assert.equal(f.messages.length, 0)
  }
})

test('concurrent Mac CPU shutdown requests cannot acknowledge one another', async () => {
  const f = fixture(), first = f.start(), second = f.start()
  let secondDone = false
  void second.then(() => { secondDone = true })
  assert.notEqual(f.messages[0].value.requestId, f.messages[1].value.requestId)
  f.reply(f.messages[0].value); await first
  assert.equal(secondDone, false)
  f.reply(f.messages[1].value); await second
  assert.equal(f.ipc.listenerCount('playback:cpu-shutdown-ready'), 0)
  assert.equal(f.timers.size, 0)
})
