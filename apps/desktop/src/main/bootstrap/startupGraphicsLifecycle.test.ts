import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createStartupGraphicsRecovery } from './startupGraphicsRecovery'

const code = transpileModule(readFileSync(new URL('../appMain.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true }
}).outputText

for (const stage of ['pre-ready', 'runtime'] as const)
test(`graphics restart at ${stage} waits only for initialization that actually started`, async () => {
  let finishRuntime!: (runtime: unknown) => void, entered!: () => void, exited!: () => void
  const creating = new Promise<void>(resolve => { entered = resolve })
  const finished = new Promise<void>(resolve => { exited = resolve })
  const runtime = new Promise(resolve => { finishRuntime = resolve })
  const order: string[] = []
  const app = Object.assign(new EventEmitter(), { requestSingleInstanceLock: () => true,
    whenReady: () => stage === 'runtime' ? Promise.resolve() : new Promise<void>(() => {}),
    getPath: () => '/fixture', getVersion: () => 'test',
    quit() { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; app.emit('before-quit', event); if (!event.defaultPrevented) { order.push('exit'); exited() } },
    exit() { assert.fail('initialization and cleanup must settle without forced exit') }
  })
  const startup = createStartupGraphicsRecovery({ disableHardwareAcceleration() {}, record() {}, failed() {}, recovered() {},
    relaunch() { order.push('relaunch-request') }, quit: () => app.quit()
  }, ['electron', '/app'])
  const noop = new Proxy(() => Promise.resolve(), { get: () => noop })
  runInNewContext(code, { exports: {}, process: { platform: 'win32', env: {} }, console, setTimeout, clearTimeout,
    require(id: string) {
      if (id === 'electron') return { app, protocol: { registerSchemesAsPrivileged() {} }, BrowserWindow: class { constructor() { assert.fail('cancelled startup cannot create a window') } } }
      if (id === './bootstrap/startupGraphics') return { startupGraphics: startup }
      if (id === './player/linuxPlaybackDevice') return { prepareLinuxPlaybackDevice: async () => {} }
      if (id === './bootstrap/createDesktopRuntime') return { createDesktopRuntime: () => { entered(); return runtime } }
      return noop
    }
  })
  if (stage === 'runtime') await creating
  startup.gpuExited({ type: 'GPU', reason: 'launch-failed' })
  if (stage === 'pre-ready') {
    await finished
    assert.deepEqual(order, ['relaunch-request', 'exit'])
    return
  }
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['relaunch-request'], 'shutdown cannot race an unfinished runtime')
  finishRuntime({ mode: 'remote', dispose: async () => { order.push('runtime-dispose') } })
  await finished
  assert.deepEqual(order, ['relaunch-request', 'runtime-dispose', 'exit'])
})
