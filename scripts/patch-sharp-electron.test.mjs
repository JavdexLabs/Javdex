import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { patchSharpSource, prepareSharp } from './patch-sharp-electron.mjs'

const require = createRequire(import.meta.url)
const installed = readFileSync(join(dirname(require.resolve('sharp')), 'sharp.cjs'), 'utf8')
const patched = patchSharpSource(installed)

test('Sharp patch is installed, idempotent and rejects unreviewed upstream changes', () => {
  prepareSharp(process.cwd(), { check: true })
  assert.equal(patchSharpSource(patched), patched)
  assert.throws(() => patchSharpSource(patched + '\n'), /loader changed/)
})

for (const [platform, electron, expected] of [
  ['linux', '43.8.0', '@img/sharp-wasm32/sharp.node'],
  ['linux', undefined, 'detect-libc'],
  ['darwin', '43.8.0', 'detect-libc'],
  ['win32', '43.8.0', 'detect-libc']
]) {
  test(`Sharp selects the correct backend for ${platform}, Electron=${electron}`, () => {
    const calls = []
    const stop = new Error('stop at first import')
    const loader = vm.runInNewContext(`(function(require, module, process) {${patched}\n})`)
    assert.throws(() => loader(name => { calls.push(name); throw stop }, { exports: {} }, {
      platform, versions: { electron }
    }), error => error === stop)
    // A missing WASM dependency must fail closed, never load conflicting GLib.
    assert.deepEqual(calls, [expected])
  })
}

test('image decode/resize/encode works in Node and Electron without native GLib collisions', { timeout: 60_000 }, async () => {
  const { spawnSync } = await import('node:child_process')
  for (const executable of [process.execPath, require('electron')]) {
    const result = spawnSync(executable, ['scripts/check-sharp-runtime.cjs'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 25_000
    })
    assert.equal(result.status, 0, `${executable}: ${result.signal}\n${result.stdout}\n${result.stderr}`)
  }
})
