import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { verifyPlaybackInstallers } from './check-playback-installers.mjs'
import { playbackInstallers } from './playback-source-materials.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'

test('installer receipt requires an inspected embedded runtime and binds final artifact bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-installer-binding-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const version = '0.9.0', target = `${{ win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]}-${process.arch}`
  const names = Object.entries(playbackInstallers(version)).filter(([, value]) => value === target).map(([name]) => name)
  for (const name of names) fs.writeFileSync(path.join(root, name), 'fixture package ' + name)
  const binding = { fileName: 'fixture-sources.tar.gz', inputInventorySha256: 'a'.repeat(64), sha256: 'b'.repeat(64), packagingToolsSha256: 'c'.repeat(64) }
  let checked = 0, cleaned = 0
  const stage = directory => {
    const resources = path.join(directory, 'resources')
    fs.mkdirSync(path.join(resources, 'native-playback'), { recursive: true })
    fs.writeFileSync(path.join(resources, 'app.asar'), 'fixture')
    fs.writeFileSync(path.join(resources, 'native-playback/runtime.json'), JSON.stringify({ platform: process.platform, arch: process.arch, electronVersion: 'fixture', sourceBundle: binding, files: { marker: 'fixture' } }))
    fs.writeFileSync(path.join(resources, 'native-playback/marker'), 'runtime fixture')
    return resources
  }
  stage(root)
  const extract = (_artifact, directory) => {
    stage(directory)
    return { root: directory, cleanup: () => { cleaned++ } }
  }
  verifyPlaybackInstallers(root, version, target, { extract, verify: resources => {
    checked++
    return { manifest: JSON.parse(fs.readFileSync(path.join(resources, 'native-playback/runtime.json'))) }
  } })
  const receipt = JSON.parse(fs.readFileSync(path.join(root, binding.fileName + '.installers.json')))
  assert.equal(checked, names.length); assert.equal(cleaned, names.length)
  for (const name of names) assert.equal(receipt.installers[name].sha256, playbackFileSha256(path.join(root, name)))
  assert.throws(() => verifyPlaybackInstallers(root, version, target, { extract: (_file, directory) => ({ root: directory, cleanup: () => {} }), verify: () => assert.fail('No inventory to verify') }), /exactly one/)
  assert.throws(() => verifyPlaybackInstallers(root, version, target, { extract: (_file, directory) => {
    const resources = stage(directory)
    fs.writeFileSync(path.join(resources, 'native-playback/marker'), 'another runtime')
    return { root: directory, cleanup: () => {} }
  }, verify: () => assert.fail('Replaced runtime must fail before verification') }), /runtime differs/)
  assert.ok(!fs.readdirSync(root).some(name => name.startsWith('.playback-installer-')))
})
