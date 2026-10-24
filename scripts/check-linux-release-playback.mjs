import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { validatePortableRuntime } from './linux-portable-runtime.mjs'
import { verifyLinuxAngleRuntime } from './linux-angle-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { linuxInventory, linuxSourceBinding, validateLinuxInventory, linuxReleaseComponents } from './linux-release-materials.mjs'

export function verifyLinuxReleaseResources(resources, output, target, {
  validateRuntime = validatePortableRuntime, verifyAngle = verifyLinuxAngleRuntime
} = {}) {
  assert.equal(target.platformName, 'linux'); assert.equal(target.archName, 'x64')
  assert.ok(!fs.existsSync(path.join(resources, 'native-playback')), 'Integrated Linux must not mix the old playback runtime')
  assert.ok(fs.lstatSync(linuxInventory(resources)).isFile() && !fs.lstatSync(linuxInventory(resources)).isSymbolicLink(), 'Invalid Linux release inventory')
  const manifest = JSON.parse(fs.readFileSync(linuxInventory(resources)))
  validateLinuxInventory(manifest)
  assert.equal(manifest.electronVersion, target.electronVersion)
  const app = path.dirname(resources)
  for (const [name, hash] of Object.entries(manifest.files)) {
    const file = path.join(app, name)
    assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Invalid Linux playback file')
    assert.equal(playbackFileSha256(file), hash, 'Packaged Linux playback file mismatch: ' + name)
  }
  for (const id of ['gpu', 'cpu']) assert.deepEqual(validateRuntime(path.join(app, linuxReleaseComponents[id].directory)), manifest.inventories[id])
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'javdex-angle.json'))), manifest.inventories.angle)
  // The matching local pair is checked with real ELF inspection and pinned
  // provenance. Above, each packaged byte is bound to that exact pair.
  assert.deepEqual(verifyAngle(), manifest.inventories.angle)
  linuxSourceBinding(output, manifest)
  assert.equal(playbackFileSha256(path.join(output, manifest.sourceBundle.fileName + '.runtime.json')), playbackFileSha256(linuxInventory(resources)), 'Linux source projection mismatch')
  return { manifest, directory: app }
}

export function checkLinuxPlaybackLoad(resources) {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64')
  const app = path.dirname(resources), temporary = fs.mkdtempSync(path.join(path.dirname(app), '.linux-playback-load-'))
  const environment = { ...process.env, PATH: '/usr/bin:/bin' }
  for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'JAVDEX_MPV_PREFIX']) delete environment[key]
  const run = (command, args, env = environment) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 ** 2 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, result.stderr)
    if (result.stdout.trim()) console.log(result.stdout.trim())
  }
  try {
    const decode = path.join(temporary, 'decode')
    run('c++', ['-std=c++17', '-Iout/linux-portable-runtime/smoke-headers', 'apps/desktop/src/main/player/native/runtimeDecode.test.cpp', '-ldl', '-o', decode])
    for (const id of ['gpu', 'cpu']) {
      const directory = path.join(app, linuxReleaseComponents[id].directory)
      const addon = path.join(directory, 'playback-fd.node')
      run(path.join(app, 'javdex'), ['-e', `const a=require(${JSON.stringify(addon)});const c=a.createChannel();if(!a.close(c.parentFd)||!a.close(c.childFd))throw Error('FD bridge ownership');console.log('Packaged Electron loaded Linux ${id} FD bridge')`], { ...environment, ELECTRON_RUN_AS_NODE: '1' })
      run(process.execPath, ['scripts/playback-linux-helper-smoke.mjs', path.join(directory, id === 'gpu' ? 'playback-dmabuf-helper' : 'playback-software-helper')])
      run(decode, [path.join(directory, 'libmpv.so.2'), path.join(temporary, id + '.wav')])
    }
    console.log('Linux packaged FD bridges, private-channel rejection and both libmpv PCM EOF checks passed; no GPU/GUI acceptance.')
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
