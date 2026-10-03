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

it('selects X11 only by an explicit Linux startup choice, never by session environment', () => {
  const automatic = host()
  configurePlaybackDisplay(automatic, { platform: 'linux', argv: [] })
  assert.equal(linuxPlaybackBackend(), null)
  assert.deepEqual(automatic.switches, [])
  const explicit = host()
  configurePlaybackDisplay(explicit, { platform: 'linux', argv: ['electron', '--javdex-x11'] })
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.deepEqual(explicit.switches, [['ozone-platform', 'x11']])
  const standard = host('x11')
  configurePlaybackDisplay(standard, { platform: 'linux', argv: [] })
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.deepEqual(standard.switches, [])
})

it('rejects conflicting or late selection without changing the running backend', () => {
  configurePlaybackDisplay(host(), { platform: 'linux', argv: [] })
  for (const selected of ['wayland', 'auto', 'headless']) {
    const conflicting = host(selected)
    assert.throws(() => configurePlaybackDisplay(conflicting, { platform: 'linux', argv: ['--javdex-x11'] }), /冲突/)
    assert.deepEqual(conflicting.switches, [])
    assert.equal(linuxPlaybackBackend(), null)
  }
  configurePlaybackDisplay(host(), { platform: 'linux', argv: ['--javdex-x11'] })
  const late = host('x11', true)
  assert.throws(() => configurePlaybackDisplay(late, { platform: 'linux', argv: ['--javdex-x11'] }), /重新启动/)
  assert.deepEqual(late.switches, [])
  assert.equal(linuxPlaybackBackend(), 'x11')
  assert.throws(() => configurePlaybackDisplay(host('wayland'), { platform: 'linux', argv: ['--javdex-x11'] }), /冲突/)
  assert.equal(linuxPlaybackBackend(), 'x11')
  for (const platform of ['darwin', 'win32'] as const) {
    const other = host()
    configurePlaybackDisplay(other, { platform, argv: ['--javdex-x11'] })
    assert.deepEqual(other.switches, [])
    assert.equal(linuxPlaybackBackend(), null)
  }
})
