import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const launcher = path.resolve('build/linux-AppRun.sh')

function launch({ probe = 0, args = [], wayland = true }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'javdex-apprun-'))
  try {
    writeFileSync(path.join(directory, 'unshare'), `#!/bin/sh\nexit ${probe}\n`, { mode: 0o755 })
    writeFileSync(path.join(directory, 'javdex'), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 })
    const env = { ...process.env, APPDIR: directory, PATH: directory,
      XDG_SESSION_TYPE: wayland ? 'wayland' : 'x11', WAYLAND_DISPLAY: wayland ? 'wayland-0' : '' }
    // Run bash directly so the probe can also simulate a missing executable.
    if (probe === null) rmSync(path.join(directory, 'unshare'))
    return execFileSync('/bin/bash', [launcher, ...args], { env, encoding: 'utf8' }).trimEnd().split('\n')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('working user namespaces preserve sandbox and CPU/media arguments', () => {
  assert.deepEqual(launch({ args: ['--javdex-cpu', '/tmp/media with spaces.avi'] }),
    ['--ozone-platform=wayland', '--javdex-wayland', '--javdex-cpu', '/tmp/media with spaces.avi'])
})

test('failed namespace probe adds compatibility flag without losing display choice', () => {
  assert.deepEqual(launch({ probe: 1, args: ['--javdex-x11', '--javdex-cpu'] }),
    ['--ozone-platform=x11', '--no-sandbox', '--javdex-x11', '--javdex-cpu'])
})

test('missing namespace probe follows released compatibility behavior', () => {
  assert.deepEqual(launch({ probe: null }), ['--ozone-platform=wayland', '--javdex-wayland', '--no-sandbox'])
})

test('explicit no-sandbox is not duplicated', () => {
  assert.deepEqual(launch({ probe: 1, args: ['--ozone-platform=wayland', '--no-sandbox'] }),
    ['--ozone-platform=wayland', '--no-sandbox'])
})

test('X11 default retains DMA-BUF selection with compatibility flag', () => {
  assert.deepEqual(launch({ probe: 1, wayland: false }),
    ['--ozone-platform=x11', '--javdex-x11', '--no-sandbox'])
})

test('display-looking media arguments after -- do not change the actual window backend', () => {
  assert.deepEqual(launch({ probe: 1, args: ['--', '--javdex-x11', '--no-sandbox'] }),
    ['--ozone-platform=wayland', '--javdex-wayland', '--no-sandbox', '--', '--javdex-x11', '--no-sandbox'])
})
