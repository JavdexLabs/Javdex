import assert from 'node:assert/strict'
import { cpSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { inspectPortableElf } from './linux-portable-runtime.mjs'

export const linuxAngleDirectory = 'out/linux-angle-runtime/linux-x64'
export function verifyLinuxAngleRuntime(directory = linuxAngleDirectory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'javdex-angle.json')))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.electronVersion, JSON.parse(readFileSync('node_modules/electron/package.json')).version)
  assert.equal(manifest.x11RequestedVisual, true)
  assert.equal(manifest.patchSha256, playbackFileSha256('build/patches/angle-x11-vulkan-visual.patch'))
  assert.equal(manifest.argsSha256, playbackFileSha256('build/angle-args.gn'))
  assert.equal(manifest.provenanceSha256, playbackFileSha256('build/angle-runtime.json'))
  assert.equal(manifest.sourceBundle.format, 'angle-rebuild-v1', 'Rebuild ANGLE to generate compact reconstruction materials')
  assert.deepEqual(Object.keys(manifest.files).sort(), ['libEGL.so', 'libGLESv2.so'])
  const allowed = new Set(['libGLESv2.so', 'libdl.so.2', 'libpthread.so.0', 'libX11.so.6', 'libXext.so.6', 'libxcb.so.1', 'libm.so.6', 'libgcc_s.so.1', 'libc.so.6', 'ld-linux-x86-64.so.2'])
  for (const [file, hash] of Object.entries(manifest.files)) {
    assert.equal(playbackFileSha256(path.join(directory, file)), hash, `ANGLE runtime mismatch: ${file}`)
    const elf = inspectPortableElf(path.join(directory, file))
    assert(elf.paths.every(p => p === '$ORIGIN'), `Non-private ANGLE search path: ${file}`)
    assert(elf.needed.every(n => allowed.has(n)), `Unexpected ANGLE dependency: ${file}`)
  }
  assert.equal(path.basename(manifest.sourceBundle.filename), manifest.sourceBundle.filename)
  const source = path.join(path.dirname(directory), manifest.sourceBundle.filename)
  assert.equal(statSync(source).size, manifest.sourceBundle.bytes)
  assert.equal(playbackFileSha256(source), manifest.sourceBundle.sha256, 'ANGLE corresponding source mismatch')
  return manifest
}
export function stageLinuxAngleRuntime(context) {
  const manifest = verifyLinuxAngleRuntime()
  for (const file of [...Object.keys(manifest.files), 'javdex-angle.json', 'ANGLE-LICENSE.txt']) cpSync(path.join(linuxAngleDirectory, file), path.join(context.appOutDir, file))
}
