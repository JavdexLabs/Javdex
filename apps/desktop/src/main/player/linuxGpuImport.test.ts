import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configurePlaybackDisplay } from './playbackDisplay'
import { configureLinuxGpuImport } from './linuxGpuImport'

function host(display = 'x11') {
  const switches = new Map<string, string>([['ozone-platform', display]])
  return { switches, isReady: () => false, commandLine: {
    hasSwitch: (key: string) => switches.has(key),
    getSwitchValue: (key: string) => switches.get(key) ?? '',
    appendSwitch: (key: string, value: string) => { switches.set(key, value) }
  } }
}
test('fixed X11 runtime selects ANGLE Vulkan with Ganesh GLES and preserves unrelated feature switches', () => {
  const h = host()
  configurePlaybackDisplay(h, { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  h.switches.set('disable-features', 'Example,Another')
  configureLinuxGpuImport(h, true)
  assert.equal(h.switches.get('use-angle'), 'vulkan')
  assert.equal(h.switches.get('disable-features'), 'Example,Another,Vulkan')
  configureLinuxGpuImport(h, true)
  assert.equal(h.switches.get('disable-features'), 'Example,Another,Vulkan')
})
test('explicit Chromium CPU compositor does not force ANGLE Vulkan', () => {
  const h = host()
  configurePlaybackDisplay(h, { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  h.switches.set('disable-gpu', '')
  configureLinuxGpuImport(h, true)
  assert.equal(h.switches.has('use-angle'), false)
})
test('does not alter Wayland, CPU mode, an unfixed runtime, or an explicit alternate ANGLE backend', () => {
  for (const [display, cpu, available, angle] of [
    ['wayland', false, true, ''], ['x11', true, true, ''],
    ['x11', false, false, ''], ['x11', false, true, 'gl-egl']
  ] as const) {
    const h = host(display)
    configurePlaybackDisplay(h, { platform: 'linux', argv: ['electron', `--ozone-platform=${display}`, ...(cpu ? ['--javdex-cpu'] : [])] })
    if (angle) h.switches.set('use-angle', angle)
    const before = [...h.switches]
    configureLinuxGpuImport(h, available)
    assert.deepEqual([...h.switches], before)
  }
})
