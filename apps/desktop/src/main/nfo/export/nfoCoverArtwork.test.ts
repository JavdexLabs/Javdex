import { it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

it('exports oriented/cropped artwork with the shipped Electron codec and encrypted asset store', {
  timeout: 30_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
    ? 'Native Electron requires a display server; run under xvfb-run' : false
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-native-artwork-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, JAVDEX_TEST_USER_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    const result = spawnSync(process.execPath, ['scripts/test-nfo-cover-artwork.cjs'], {
      env, encoding: 'utf8', timeout: 25_000, windowsHide: true
    })
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`)
    assert.match(result.stdout, /NFO_NATIVE_ARTWORK_OK/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
