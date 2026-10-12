import assert from 'node:assert/strict'
import { it } from 'node:test'
import { configurePlaybackDisplay, linuxPlaybackBackend } from './playbackDisplay'

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
    assert.equal(linuxPlaybackBackend(), 'x11')
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
    assert.equal(linuxPlaybackBackend(), 'x11', JSON.stringify(args))
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
    ['--ozone-platform=x11', '--ozone-platform=wayland'],
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
    ['--ozone-platform=wayland', '--', '--ozone-platform=x11', '--javdex-x11']
  ]) {
    const automatic = host('x11')
    configurePlaybackDisplay(automatic, { platform: 'linux', argv: ['electron', 'app', ...args] })
    assert.equal(linuxPlaybackBackend(), null, JSON.stringify(args))
    assert.deepEqual(automatic.switches, [])
  }
  const standard = host('x11')
  configurePlaybackDisplay(standard, { platform: 'linux', argv: ['electron', '--ozone-platform=x11', '--', '--ozone-platform=wayland'] })
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.deepEqual(standard.switches, [])
  const explicit = host()
  configurePlaybackDisplay(explicit, { platform: 'linux', argv: ['electron', '--javdex-x11', ' \t--\r\n', '--ozone-platform=wayland'] })
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.deepEqual(explicit.switches, [['ozone-platform', 'x11']])
})

it('rejects explicit conflicting choices without changing switches or backend state', () => {
  for (const backend of [null, 'x11']) {
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
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.deepEqual(matching.switches, [['ozone-platform', 'x11']])
})

it('rejects late Linux selection and ignores Linux flags on other platforms', () => {
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  const late = host('x11', true)
  assert.throws(() => configurePlaybackDisplay(late, { platform: 'linux', argv: ['electron', '--javdex-x11'] }), /重新启动/)
  assert.deepEqual(late.switches, [])
  assert.equal(linuxPlaybackBackend(), 'x11')
  for (const platform of ['darwin', 'win32'] as const) {
    const other = host()
    configurePlaybackDisplay(other, { platform, argv: ['electron', '--javdex-x11', '--ozone-platform=wayland'] })
    assert.deepEqual(other.switches, [])
    assert.equal(linuxPlaybackBackend(), null)
  }
})
