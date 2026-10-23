import assert from 'node:assert/strict'
import { it } from 'node:test'
import { configurePlaybackDisplay, linuxPlaybackBackend, windowsCanvasPlayback } from './playbackDisplay'

function host(selected = '', ready = false) {
  const switches: string[][] = []
  return { switches, isReady: () => ready, commandLine: {
    getSwitchValue: () => selected,
    appendSwitch: (name: string, value: string) => { switches.push([name, value]) }
  } }
}

it('selects a Windows composition path that exposes installed WGL child surfaces before ready', () => {
  const windows = host()
  configurePlaybackDisplay(windows, { platform: 'win32', windowsNativePlayback: true })
  assert.deepEqual(windows.switches, [['disable-direct-composition', '']])
  assert.equal(linuxPlaybackBackend(), null)
  assert.throws(() => configurePlaybackDisplay(host('', true), { platform: 'win32', windowsNativePlayback: true }), /重新启动/)
})

it('Windows Canvas opt-in is exact, before ready and does not disable DirectComposition', () => {
  const canvas = host()
  configurePlaybackDisplay(canvas, { platform: 'win32', windowsNativePlayback: true, argv: ['electron', '--javdex-windows-canvas'] })
  assert.equal(windowsCanvasPlayback(), true); assert.deepEqual(canvas.switches, [])
  assert.throws(() => configurePlaybackDisplay(host('', true), { platform: 'win32', argv: ['electron', '--javdex-windows-canvas'] }), /重新启动/)
  for (const argv of [['electron'], ['--javdex-windows-canvas'], ['electron', '--javdex-windows-canvas=false'],
    ['electron', '--other=--javdex-windows-canvas'], ['electron', ' \t--\r\n', '--javdex-windows-canvas']]) {
    const legacy = host()
    configurePlaybackDisplay(legacy, { platform: 'win32', windowsNativePlayback: true, argv })
    assert.equal(windowsCanvasPlayback(), false); assert.deepEqual(legacy.switches, [['disable-direct-composition', '']])
  }
  configurePlaybackDisplay(host(), { platform: 'darwin', argv: ['electron', '--javdex-windows-canvas'] })
  assert.equal(windowsCanvasPlayback(), false)
})
it('preserves normal composition without a Windows native runtime and on other platforms', () => {
  for (const platform of ['win32', 'darwin'] as const) {
    const withoutRuntime = host()
    configurePlaybackDisplay(withoutRuntime, { platform })
    assert.deepEqual(withoutRuntime.switches, [])
  }
  const mac = host()
  configurePlaybackDisplay(mac, { platform: 'darwin', windowsNativePlayback: true })
  assert.deepEqual(mac.switches, [])
  const linux = host()
  configurePlaybackDisplay(linux, { platform: 'linux', argv: ['electron', '--javdex-x11'], windowsNativePlayback: true })
  assert.deepEqual(linux.switches, [['ozone-platform', 'x11']])
})

it('does not mistake Electron defaults for an explicit X11 startup choice', () => {
  for (const selected of ['', 'x11', 'wayland', 'auto', 'headless']) {
    configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--javdex-x11'] })
    const automatic = host(selected)
    configurePlaybackDisplay(automatic, { platform: 'linux', argv: ['electron', 'app'] })
    assert.equal(linuxPlaybackBackend(), null, selected)
    assert.deepEqual(automatic.switches, [])
  }
})

it('allows the Javdex opt-in to replace any implicit Electron default before ready', () => {
  for (const selected of ['', 'x11', 'wayland', 'auto', 'headless']) {
    const explicit = host(selected)
    configurePlaybackDisplay(explicit, { platform: 'linux', argv: ['electron', 'app', '--javdex-x11'] })
    assert.equal(linuxPlaybackBackend(), 'dmabuf')
    assert.deepEqual(explicit.switches, [['ozone-platform', 'x11']])
  }
})

it('accepts explicit ozone X11 switches and uses the last duplicate value like Chromium', () => {
  for (const args of [
    ['--ozone-platform=x11'],
    ['-ozone-platform=x11'],
    ['--ozone-platform=wayland', '--ozone-platform=x11'],
    ['--ozone-platform=x11', '-ozone-platform=x11'],
    [' \t--ozone-platform=x11\r\n']
  ]) {
    const standard = host('x11')
    configurePlaybackDisplay(standard, { platform: 'linux', argv: ['electron', 'app', ...args] })
    assert.equal(linuxPlaybackBackend(), 'dmabuf', JSON.stringify(args))
    assert.deepEqual(standard.switches, [])
  }
})

it('does not enable playback from positional, malformed, or overridden X11 arguments', () => {
  for (const args of [
    ['--ozone-platform', 'x11'],
    ['--ozone-platform='],
    ['--ozone-platform=X11'],
    ['--ozone-platform=x11=wayland'],
    ['--ozone-platform-hint=x11'],
    ['--other=--ozone-platform=x11'],
    ['--javdex-x11=false'],
    ['--javdex-x11-extra'],
        ['--ozone-platform=x11', '-ozone-platform=auto'],
    ['--ozone-platform=x11', '--ozone-platform'],
    ['--ozone-platform=x11', '--ozone-platform=']
  ]) {
    const automatic = host('x11')
    configurePlaybackDisplay(automatic, { platform: 'linux', argv: ['electron', 'app', ...args] })
    assert.equal(linuxPlaybackBackend(), null, JSON.stringify(args))
    assert.deepEqual(automatic.switches, [])
  }
  for (const executable of ['--javdex-x11', '--ozone-platform=x11']) {
    configurePlaybackDisplay(host('x11'), { platform: 'linux', argv: [executable] })
    assert.equal(linuxPlaybackBackend(), null)
  }
})

it('honors the end-of-switches marker for both the opt-in and conflict detection', () => {
  for (const args of [
    ['--', '--javdex-x11'],
    ['--', '--ozone-platform=x11'],
      ]) {
    const automatic = host('x11')
    configurePlaybackDisplay(automatic, { platform: 'linux', argv: ['electron', 'app', ...args] })
    assert.equal(linuxPlaybackBackend(), null, JSON.stringify(args))
    assert.deepEqual(automatic.switches, [])
  }
  const standard = host('x11')
  configurePlaybackDisplay(standard, { platform: 'linux', argv: ['electron', '--ozone-platform=x11', '--', '--ozone-platform=wayland'] })
  assert.equal(linuxPlaybackBackend(), 'dmabuf')
  assert.deepEqual(standard.switches, [])
  const explicit = host()
  configurePlaybackDisplay(explicit, { platform: 'linux', argv: ['electron', '--javdex-x11', ' \t--\r\n', '--ozone-platform=wayland'] })
  assert.equal(linuxPlaybackBackend(), 'dmabuf')
  assert.deepEqual(explicit.switches, [['ozone-platform', 'x11']])
})

it('rejects explicit conflicting choices without changing switches or backend state', () => {
  for (const backend of [null, 'dmabuf']) {
    configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', ...(backend ? ['--javdex-x11'] : [])] })
    for (const selected of ['wayland', 'auto', 'headless', '']) {
      for (const args of [
        ['--javdex-x11', `--ozone-platform=${selected}`],
        [`--ozone-platform=${selected}`, '--javdex-x11'],
        ['--javdex-x11', '--ozone-platform=x11', `-ozone-platform=${selected}`]
      ]) {
        const conflicting = host('x11')
        assert.throws(() => configurePlaybackDisplay(conflicting, { platform: 'linux', argv: ['electron', ...args] }), /冲突/)
        assert.deepEqual(conflicting.switches, [])
        assert.equal(linuxPlaybackBackend(), backend)
      }
    }
    const missingValue = host('x11')
    assert.throws(() => configurePlaybackDisplay(missingValue, { platform: 'linux', argv: ['electron', '--javdex-x11', '--ozone-platform', 'x11'] }), /冲突/)
    assert.deepEqual(missingValue.switches, [])
    assert.equal(linuxPlaybackBackend(), backend)
  }
  const matching = host('x11')
  configurePlaybackDisplay(matching, { platform: 'linux', argv: ['electron', '--ozone-platform=wayland', '--javdex-x11', '--ozone-platform=x11'] })
  assert.equal(linuxPlaybackBackend(), 'dmabuf')
  assert.deepEqual(matching.switches, [['ozone-platform', 'x11']])
})

it('rejects late Linux selection and ignores Linux flags on other platforms', () => {
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  const late = host('x11', true)
  assert.throws(() => configurePlaybackDisplay(late, { platform: 'linux', argv: ['electron', '--javdex-x11'] }), /重新启动/)
  assert.deepEqual(late.switches, [])
  assert.equal(linuxPlaybackBackend(), 'dmabuf')
  for (const platform of ['darwin', 'win32'] as const) {
    const other = host()
    configurePlaybackDisplay(other, { platform, argv: ['electron', '--javdex-x11', '--ozone-platform=wayland'] })
    assert.deepEqual(other.switches, [])
    assert.equal(linuxPlaybackBackend(), null)
  }
})

it('opts into shared textures independently of X11 or Wayland window presentation', () => {
  for (const [args, expected] of [
    [['--javdex-wayland'], [['ozone-platform', 'wayland']]],
    [['--javdex-dmabuf'], [['ozone-platform', 'wayland']]],
    [['--javdex-dmabuf', '--javdex-x11'], [['ozone-platform', 'x11']]],
    [['--javdex-dmabuf', '--ozone-platform=x11'], []],
    [['--javdex-dmabuf', '--ozone-platform=wayland'], []]
  ] as const) {
    const selected = host()
    configurePlaybackDisplay(selected, { platform: 'linux', argv: ['electron', ...args] })
    assert.equal(linuxPlaybackBackend(), 'dmabuf')
    assert.deepEqual(selected.switches, expected)
  }
})

it('rejects conflicting shared-texture display arguments without mutating configuration', () => {
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  for (const args of [
    ['--javdex-x11', '--javdex-wayland'],
    ['--javdex-wayland', '--ozone-platform=x11'],
    ['--javdex-dmabuf', '--ozone-platform=auto'],
    ['--javdex-dmabuf', '--ozone-platform=headless']
  ]) {
    const selected = host()
    assert.throws(() => configurePlaybackDisplay(selected, { platform: 'linux', argv: ['electron', ...args] }))
    assert.deepEqual(selected.switches, [])
    assert.equal(linuxPlaybackBackend(), 'dmabuf')
  }
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--', '--javdex-wayland', '--javdex-dmabuf'] })
  assert.equal(linuxPlaybackBackend(), null)
})

it('selects CPU without changing the explicit Wayland display identity', () => {
  const linux = host()
  configurePlaybackDisplay(linux, { platform: 'linux', argv: ['electron', '--javdex-wayland', '--javdex-cpu'] })
  assert.equal(linuxPlaybackBackend(), 'software')
  assert.deepEqual(linux.switches, [['ozone-platform', 'wayland']])
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--', '--javdex-cpu'] })
  assert.equal(linuxPlaybackBackend(), null)
})
