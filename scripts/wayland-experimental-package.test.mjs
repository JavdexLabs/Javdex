import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EXPERIMENTAL_VERSION, verifyExperimentalRuntime } from './wayland-experimental-package.mjs'
import experimentalConfig from '../electron-builder.wayland-experimental.config.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-texture-package-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const names = ['playback-fd.node', 'playback-dmabuf-helper', 'playback-cpu-helper', 'libmpv.so.2', 'LICENSE', 'libmpv-LICENSE.txt', 'SOURCE-ACCESS.txt',
    'fonts/NotoSans-Regular.ttf', 'fonts/LICENSE.txt', 'fonts/SOURCE.json']
  const files = {}
  fs.mkdirSync(path.join(directory, 'fonts'))
  for (const name of names) { fs.writeFileSync(path.join(directory, name), name); files[name] = digest(name) }
  const inspected = { dependencies: ['libc.so.6'], glibc: 'GLIBC_2.34', glibcxx: null }
  const manifest = { schemaVersion: 1, experimental: true, platform: 'linux', arch: 'x64', version: EXPERIMENTAL_VERSION,
    electronVersion: '43.8.0', mpvVersion: '0.41.0', reviewedLibmpvSha256: files['libmpv.so.2'], files,
    sourceBundle: { fileName: 'sources.tar.gz', sha256: digest('source') },
    elf: Object.fromEntries(names.slice(0, 4).map(name => [name, inspected])) }
  const write = () => fs.writeFileSync(path.join(directory, 'experimental-runtime.json'), JSON.stringify(manifest))
  write()
  return { directory, manifest, write, inspect: () => inspected }
}
test('experimental config has a separate identity and retains both normal hooks', () => {
  const config = experimentalConfig()
  assert.equal(config.extraMetadata.javdexExperimentalLinux, true)
  assert.equal(config.extraMetadata.version, EXPERIMENTAL_VERSION)
  assert.notEqual(config.appId, 'com.javdex.app')
  assert.equal(config.publish, null)
  assert.deepEqual(config.linux.executableArgs, [])
  const launcher = fs.readFileSync(new URL('../build/linux-texture-AppRun.sh', import.meta.url), 'utf8')
  assert.ok(!launcher.includes('--no-sandbox'))
  assert.match(launcher, /exec "\$APPDIR\/javdex-linux-texture-experimental" "\$@"/)
  assert.deepEqual(config.linux.target, [{ target: 'AppImage', arch: ['x64'] }])
  assert.equal(typeof config.beforePack, 'function'); assert.equal(typeof config.afterPack, 'function')
})
test('experimental inventory accepts exact files and rejects changed bytes', t => {
  const f = fixture(t)
  assert.equal(verifyExperimentalRuntime(f.directory, f).experimental, true)
  fs.appendFileSync(path.join(f.directory, 'playback-fd.node'), 'changed')
  assert.throws(() => verifyExperimentalRuntime(f.directory, f), /hash mismatch/)
})
test('experimental inventory rejects extra files and symlinks', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.directory, 'unexpected.so'), 'foreign library')
  assert.throws(() => verifyExperimentalRuntime(f.directory, f))
  fs.unlinkSync(path.join(f.directory, 'unexpected.so'))
  fs.unlinkSync(path.join(f.directory, 'LICENSE'))
  fs.symlinkSync('libmpv-LICENSE.txt', path.join(f.directory, 'LICENSE'))
  assert.throws(() => verifyExperimentalRuntime(f.directory, f), /regular file/)
})
test('experimental font inventory rejects replacements, extra files and linked directories', t => {
  const f = fixture(t)
  const fonts = path.join(f.directory, 'fonts')
  fs.appendFileSync(path.join(fonts, 'NotoSans-Regular.ttf'), 'changed')
  assert.throws(() => verifyExperimentalRuntime(f.directory, f), /hash mismatch/)
  fs.writeFileSync(path.join(fonts, 'NotoSans-Regular.ttf'), 'fonts/NotoSans-Regular.ttf')
  fs.writeFileSync(path.join(fonts, 'unexpected.ttf'), 'extra')
  assert.throws(() => verifyExperimentalRuntime(f.directory, f))
  fs.unlinkSync(path.join(fonts, 'unexpected.ttf'))
  const moved = fonts + '-elsewhere'
  fs.renameSync(fonts, moved)
  fs.symlinkSync(moved, fonts)
  assert.throws(() => verifyExperimentalRuntime(f.directory, f))
})
test('experimental inventory binds libmpv to reviewed digest and ABI evidence', t => {
  const f = fixture(t)
  f.manifest.reviewedLibmpvSha256 = digest('different runtime'); f.write()
  assert.throws(() => verifyExperimentalRuntime(f.directory, f))
  f.manifest.reviewedLibmpvSha256 = f.manifest.files['libmpv.so.2']; f.write()
  assert.throws(() => verifyExperimentalRuntime(f.directory, { inspect: () => ({ dependencies: [] }) }))
})
test('experimental inventory rejects missing or mismatched corresponding source', t => {
  const f = fixture(t)
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-texture-source-'))
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }))
  assert.throws(() => verifyExperimentalRuntime(f.directory, { ...f, sourceDirectory }))
  fs.writeFileSync(path.join(sourceDirectory, 'sources.tar.gz'), 'source')
  verifyExperimentalRuntime(f.directory, { ...f, sourceDirectory })
  fs.appendFileSync(path.join(sourceDirectory, 'sources.tar.gz'), 'changed')
  assert.throws(() => verifyExperimentalRuntime(f.directory, { ...f, sourceDirectory }), /source archive mismatch/)
  f.manifest.sourceBundle.fileName = '../sources.tar.gz'; f.write()
  assert.throws(() => verifyExperimentalRuntime(f.directory, f))
})

test('experimental launcher preserves arguments even when namespace probing would fail', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-texture-launcher-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.copyFileSync(new URL('../build/linux-texture-AppRun.sh', import.meta.url), path.join(directory, 'AppRun'))
  fs.chmodSync(path.join(directory, 'AppRun'), 0o755)
  fs.writeFileSync(path.join(directory, 'javdex-linux-texture-experimental'), '#!/bin/sh\nprintf "%s\\0" "$@"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(directory, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const result = spawnSync(path.join(directory, 'AppRun'), ['movie file.mkv', '--javdex-wayland'], {
    env: { ...process.env, APPDIR: directory }, encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.split('\0'), ['movie file.mkv', '--javdex-wayland', ''])
})
