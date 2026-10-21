import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const code = transpileModule(readFileSync(new URL('./linuxPlaybackDevice.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 }
}).outputText
function fixture() {
  const exports = {} as typeof import('./linuxPlaybackDevice')
  const env: Record<string, string> = {}
  let override = '', display = 'wayland', extensions: string | undefined = 'EGL_EXT_image_dma_buf_import', queryFails = false
  let fixedRuntime = false, angle = '', compositing = 'enabled'
  let stalled = false, expire = () => {}
  const devices = [{ active: false, vendorId: 0x8086, deviceId: 0x4680 }, { active: true, vendorId: 0x10de, deviceId: 0x2704 }]
  runInNewContext(code, { exports, process: { platform: 'linux', env }, setTimeout: (callback: () => void) => { expire = callback; return 1 }, clearTimeout: () => {}, require(id: string) {
    if (id === 'electron') return { app: { commandLine: { getSwitchValue: (key: string) => key === 'ozone-platform' ? display : key === 'use-angle' ? angle : override },
      getGPUFeatureStatus: () => ({ gpu_compositing: compositing }),
      getGPUInfo: async () => { if (stalled) return new Promise(() => {}); if (queryFails) throw new Error('GPU unavailable'); return { gpuDevice: devices, auxAttributes: { glWsExtensions: extensions } } } } }
    if (id === './playbackDisplay') return { linuxPlaybackBackend: () => 'dmabuf' }
    if (id === './linuxGpuImport') return { hasX11GpuRuntime: () => fixedRuntime }
    if (id === 'node:fs') return { readdirSync: () => ['card0', 'renderD128', 'renderD129', 'renderD130'],
      readFileSync: (path: string) => {
        if (path.includes('renderD130')) throw new Error('unplugged')
        return path.includes('renderD128') ? path.endsWith('vendor') ? '0x8086\n' : '0x4680\n'
          : path.endsWith('vendor') ? '0x10de\n' : '0x2704\n'
      } }
    throw new Error(`Unexpected dependency ${id}`)
  } })
  return { exports, devices, env, stall: () => { stalled = true }, expire: () => expire(), runtime: (fixed: boolean, backend: string, status = 'enabled') => { fixedRuntime = fixed; angle = backend; compositing = status }, override: (value: string) => { override = value }, fail: () => { queryFails = true }, display: (value: string) => { display = value }, extensions: (value: string | undefined) => { extensions = value } }
}
test('matches the active Chromium adapter instead of the first render node', async () => {
  const f = fixture()
  await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD129')
  f.devices[0].active = true; f.devices[1].active = false
  await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD128')
})
test('ambiguous or missing adapters fail closed, without breaking startup', async () => {
  const f = fixture(), device = f.devices[1]
  assert.equal(f.exports.matchPlaybackRenderNode([device], [1, 2].map(id => ({ ...device, path: `/dev/dri/renderD${id}` }))), undefined)
  f.devices[1].active = false
  await f.exports.prepareLinuxPlaybackDevice()
  assert.throws(f.exports.linuxPlaybackRenderNode, /无法确定/)
  f.fail(); await f.exports.prepareLinuxPlaybackDevice()
  assert.throws(f.exports.linuxPlaybackRenderNode, /无法确定/)
})
test('preserves explicit helper and Chromium overrides and rejects non-render paths', async () => {
  const f = fixture(); f.fail(); f.override('/dev/dri/renderD129')
  await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD129')
  f.env.JAVDEX_DRM_RENDER_NODE = '/dev/dri/renderD128'
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD128')
  f.env.JAVDEX_DRM_RENDER_NODE = '/tmp/arbitrary'
  assert.throws(f.exports.linuxPlaybackRenderNode, /无法确定/)
})

test('rejects the unverified X11 pixmap fallback before GPU playback, including explicit render nodes', async () => {
  const f = fixture(); f.display('x11'); f.extensions('EGL_KHR_image EGL_EXT_image_dma_buf_import_modifiers')
  for (const override of ['', '/dev/dri/renderD129']) {
    f.override(override)
    await f.exports.prepareLinuxPlaybackDevice()
    assert.throws(() => f.exports.linuxPlaybackRenderNode(), /X11.*DMA-BUF/)
  }
  f.env.JAVDEX_DRM_RENDER_NODE = '/dev/dri/renderD128'
  assert.throws(() => f.exports.linuxPlaybackRenderNode(), /X11.*DMA-BUF/)
})
test('allows direct X11 DMA-BUF import and keeps Wayland matching independent of X11 pixmap support', async () => {
  const f = fixture(); f.display('x11')
  await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD129')
  f.extensions(''); await f.exports.prepareLinuxPlaybackDevice()
  assert.throws(() => f.exports.linuxPlaybackRenderNode(), /X11/)
  f.display('wayland'); await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD129')
})
test('missing Linux Electron extension data only permits the verified Vulkan runtime with GPU compositing', async () => {
  const f = fixture(); f.display('x11'); f.extensions(undefined)
  for (const [fixed, angle, status] of [[false, 'vulkan', 'enabled'], [true, 'gl', 'enabled'], [true, 'vulkan', 'disabled_software']] as const) {
    f.runtime(fixed, angle, status); await f.exports.prepareLinuxPlaybackDevice()
    assert.throws(f.exports.linuxPlaybackRenderNode, /X11/)
  }
  f.runtime(true, 'vulkan'); await f.exports.prepareLinuxPlaybackDevice()
  assert.equal(f.exports.linuxPlaybackRenderNode(), '/dev/dri/renderD129')
  f.extensions(''); await f.exports.prepareLinuxPlaybackDevice()
  assert.throws(f.exports.linuxPlaybackRenderNode, /X11/)
})

test('a stalled GPU query cannot indefinitely block library startup and CPU fallback', async () => {
  const f = fixture(); f.stall()
  const preparing = f.exports.prepareLinuxPlaybackDevice()
  f.expire(); await preparing
  assert.throws(f.exports.linuxPlaybackRenderNode, /无法确定/)
})
