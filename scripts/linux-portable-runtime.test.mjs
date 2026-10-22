import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { inspectPortableElf, portableHostLibraries, softwareHostLibraries, validatePortableRuntime } from './linux-portable-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'

function fixture(extra = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'javdex-portable-'))
  writeFileSync(path.join(root, 'entry.c'), 'int main(void) { return 0; }\n')
  execFileSync('cc', [path.join(root, 'entry.c'), '-Wl,-rpath,$ORIGIN:$ORIGIN/lib', ...extra, '-o', path.join(root, 'playback-dmabuf-helper')])
  for (const file of ['playback-fd.node', 'libmpv.so.2']) cpSync(path.join(root, 'playback-dmabuf-helper'), path.join(root, file))
  writeFileSync(path.join(root, 'LICENSE'), 'fixture\n')
  const files = Object.fromEntries(['entry.c', 'LICENSE', 'playback-dmabuf-helper', 'playback-fd.node', 'libmpv.so.2'].map(f => [f, playbackFileSha256(path.join(root, f))]))
  const elf = Object.fromEntries(['playback-dmabuf-helper', 'playback-fd.node', 'libmpv.so.2'].map(f => [f, inspectPortableElf(path.join(root, f))]))
  const manifest = { schemaVersion: 1, driverAbi: 'host-vaapi-cxx-v1', profile: 'linux-x64-dmabuf-pulse', hostLibraries: [...portableHostLibraries].sort(), files, elf,
    components: [{ name: 'fixture', sourceLock: 'fixture', licenseFile: 'LICENSE', binaries: Object.keys(elf) }] }
  const save = () => writeFileSync(path.join(root, 'portable-runtime.json'), JSON.stringify(manifest))
  save(); return { root, manifest, save }
}
test('portable closure accepts a fully inventoried private ELF tree', () => {
  const f = fixture(); validatePortableRuntime(f.root)
})
test('portable closure rejects unresolved non-driver libraries even with matching hashes', () => {
  const build = mkdtempSync(path.join(tmpdir(), 'javdex-dependency-'))
  writeFileSync(path.join(build, 'dep.c'), 'void dep(void) {}')
  execFileSync('cc', ['-shared', '-fPIC', path.join(build, 'dep.c'), '-Wl,-soname,libmissing.so.1', '-o', path.join(build, 'libmissing.so')])
  const f = fixture(['-Wl,--no-as-needed', '-L' + build, '-lmissing'])
  assert.throws(() => validatePortableRuntime(f.root), /Unresolved portable dependency/)
})
test('portable closure rejects tampering, extras, missing provenance and altered host allowlist', () => {
  const f = fixture()
  writeFileSync(path.join(f.root, 'LICENSE'), 'tampered')
  assert.throws(() => validatePortableRuntime(f.root), /hash mismatch/)
  f.manifest.files.LICENSE = playbackFileSha256(path.join(f.root, 'LICENSE')); f.save()
  writeFileSync(path.join(f.root, 'extra'), 'extra')
  assert.throws(() => validatePortableRuntime(f.root), /Unlisted/)
  f.manifest.files.extra = playbackFileSha256(path.join(f.root, 'extra')); f.manifest.components[0].sourceLock = undefined; f.save()
  assert.throws(() => validatePortableRuntime(f.root), /provenance/)
  f.manifest.components[0].sourceLock = 'fixture'; f.manifest.hostLibraries.push('libasound.so.2'); f.save()
  assert.throws(() => validatePortableRuntime(f.root))
})
test('ELF inspection rejects another architecture', () => {
  const f = fixture(), file = path.join(f.root, 'playback-fd.node'), bytes = readFileSync(file)
  bytes.writeUInt16LE(183, 18); writeFileSync(file, bytes)
  assert.throws(() => inspectPortableElf(file), /x86_64/)
})
test('portable closure rejects development search paths and newer glibc', () => {
  const f = fixture(['-Wl,-rpath,/tmp/development'])
  assert.throws(() => validatePortableRuntime(f.root), /Non-private/)
  const good = fixture(), file = path.join(good.root, 'playback-fd.node')
  const bytes = readFileSync(file), index = bytes.indexOf(Buffer.from('GLIBC_2.34'))
  assert.ok(index >= 0)
  bytes.write('GLIBC_2.99', index); writeFileSync(file, bytes)
  assert.throws(() => inspectPortableElf(file), /newer than glibc/)
})
test('portable helper rejects a separate GL forwarding runtime', () => {
  const build = mkdtempSync(path.join(tmpdir(), 'javdex-gl-forwarder-'))
  writeFileSync(path.join(build, 'gl.c'), 'void optionalGL(void) {}')
  execFileSync('cc', ['-shared', '-fPIC', path.join(build, 'gl.c'), '-Wl,-soname,libOpenGL.so.0', '-o', path.join(build, 'libGLForwarder.so')])
  const f = fixture(['-Wl,--no-as-needed', '-L' + build, '-lGLForwarder'])
  assert.throws(() => validatePortableRuntime(f.root), /must use EGL GL entry points/)
})


test('GPU driver ABI uses host VA-API and C++ while CPU retains its private closure', () => {
  for (const name of ['libva.so.2', 'libva-drm.so.2', 'libva-x11.so.2', 'libstdc++.so.6', 'libgcc_s.so.1']) {
    assert(portableHostLibraries.has(name))
    assert(!softwareHostLibraries.has(name))
  }
  const f = fixture()
  f.manifest.driverAbi = 'unknown'; f.save()
  assert.throws(() => validatePortableRuntime(f.root), /Unknown driver ABI/)
  delete f.manifest.driverAbi
  f.manifest.hostLibraries = f.manifest.hostLibraries.filter(n => !/^(libva|libstdc\+\+|libgcc_s)/.test(n))
  f.save(); validatePortableRuntime(f.root) // Preserved pre-policy packages remain inspectable.
})


test('GPU closure rejects a bundled library that shadows the selected host driver ABI', () => {
  const f = fixture()
  mkdirSync(path.join(f.root, 'lib'))
  const file = 'lib/libva.so.2'
  cpSync(path.join(f.root, 'playback-fd.node'), path.join(f.root, file))
  f.manifest.files[file] = playbackFileSha256(path.join(f.root, file))
  f.manifest.elf[file] = f.manifest.elf['playback-fd.node']
  f.manifest.components[0].binaries.push(file)
  f.save()
  assert.throws(() => validatePortableRuntime(f.root), /Host driver ABI must not be shadowed/)
})
