import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./linuxSharedTexture.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
const token = '11111111-1111-4111-8111-111111111111'
function fixture(options: { registerFails?: boolean; contextFails?: boolean } = {}) {
  let nextToken = 0, draws = 0, closes = 0, releases = 0, clears = 0, drawFails = false
  let receiver!: (data: unknown, metadata: unknown) => Promise<void>
  const messages: Array<{ channel: string; data: { surfaceToken: string; bindingToken: string } }> = []
  const canvas = { width: 0, height: 0, isConnected: true, dataset: { playbackSurface: token },
    getContext: () => {
      if (options.contextFails) throw new Error('Canvas context unavailable')
      return { drawImage: () => { if (drawFails) throw new Error('draw failed'); draws++ }, clearRect: () => { clears++ } }
    } }
  const exports = {} as typeof import('./linuxSharedTexture')
  runInNewContext(code, { exports, process: { platform: 'linux', isMainFrame: true },
    crypto: { randomUUID: () => `33333333-3333-4333-8333-${String(++nextToken).padStart(12, '0')}` },
    document: { querySelectorAll: () => [canvas] },
    require(id: string) {
      assert.equal(id, 'electron')
      return { ipcRenderer: { send: (channel: string, data: typeof messages[number]['data']) => messages.push({ channel, data }) },
        sharedTexture: { setSharedTextureReceiver: (callback: typeof receiver) => { if (options.registerFails) throw new Error('Receiver unavailable'); receiver = callback } } }
    } }
  )
  const bind = exports.installLinuxSharedTextureReceiver()
  const packet = { importedSharedTexture: { getVideoFrame: () => ({ displayWidth: 320, displayHeight: 180, close: () => { closes++ } }),
    release: () => { releases++ } } }
  return { bind, messages, canvas, counts: () => ({ draws, closes, releases, clears }),
    failDraw: () => { drawFails = true },
    receive: (sequence: number, binding = [...messages].reverse().find(item => item.channel.endsWith('ready'))!.data) => receiver(packet, { ...binding, sequence }) }
}
test('draws on the mounted canvas and releases VideoFrame and imported texture in finally', async () => {
  const f = fixture(); const unbind = f.bind(token)
  await f.receive(1)
  assert.equal(f.canvas.width, 320); assert.equal(f.canvas.height, 180)
  assert.deepEqual(f.counts(), { draws: 1, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-drawn')
  unbind(); unbind()
  assert.equal(f.counts().clears, 1)
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-removed')
})
test('stale sessions, duplicate frames, detached canvases and old mount tokens cannot draw', async () => {
  const f = fixture(); const firstCleanup = f.bind(token)
  const old = f.messages.at(-1)!.data
  await f.receive(1)
  await f.receive(1)
  await f.receive(2, { ...old, surfaceToken: 'old-session' })
  f.bind(token); firstCleanup()
  await f.receive(2, old)
  await f.receive(2)
  f.canvas.isConnected = false
  await f.receive(3)
  assert.deepEqual(f.counts(), { draws: 2, closes: 2, releases: 6, clears: 0 })
})
test('drawing failures always close the frame and imported reference and notify main', async () => {
  const f = fixture(); f.bind(token); f.failDraw()
  await f.receive(1)
  assert.deepEqual(f.counts(), { draws: 0, closes: 1, releases: 1, clears: 0 })
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-failed')
})
test('unbound frames release without attempting to create a VideoFrame', async () => {
  const f = fixture(); const cleanup = f.bind(token); const binding = f.messages.at(-1)!.data
  cleanup(); await f.receive(1, binding)
  assert.deepEqual(f.counts(), { draws: 0, closes: 0, releases: 1, clears: 1 })
})
test('invalid tokens cannot select arbitrary DOM elements or send registration IPC', () => {
  const f = fixture(); f.bind('[data-secret]')()
  assert.deepEqual(f.messages, [])
})

for (const options of [{ registerFails: true }, { contextFails: true }]) test(`unsupported shared-texture setup fails closed without breaking the preload (${JSON.stringify(options)})`, () => {
  const f = fixture(options)
  assert.doesNotThrow(() => f.bind(token)())
  assert.equal(f.messages.at(-1)?.channel, 'playback:shared-texture-failed')
  assert.deepEqual(f.counts(), { draws: 0, closes: 0, releases: 0, clears: 0 })
})
