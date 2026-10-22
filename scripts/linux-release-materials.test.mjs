import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { c as createTar } from 'tar'
import { linuxReleaseFixture, write } from './test-support/linux-release-fixture.mjs'
import { linuxReleaseComponents, linuxInventory, verifyLinuxSourceBundle, validateLinuxInventory } from './linux-release-materials.mjs'
import { playbackFileSha256 as hash } from './playback-runtime.mjs'
import { verifyPlaybackInstallers } from './check-playback-installers.mjs'
import { playbackInstallers } from './playback-source-materials.mjs'
import { verifyLinuxReleaseResources } from './check-linux-release-playback.mjs'
import { copyPortableRecipe } from './linux-portable-runtime.mjs'
import { spawnSync } from 'node:child_process'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-linux-release-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, ...await linuxReleaseFixture(root) }
}
async function repack(f, id) {
  await createTar({ cwd: f.inputs[id], file: f.archives[id], gzip: true }, ['.'])
  f.inventories[id].sourceBundle.sha256 = hash(f.archives[id])
  write(f.app, path.join(linuxReleaseComponents[id].directory, linuxReleaseComponents[id].manifest), f.inventories[id])
  return f.rebuild()
}
test('Linux companion binds three complete component sources and can be safely reused', async t => {
  const f = await fixture(t)
  await verifyLinuxSourceBundle(f.output, f.manifest)
  assert.deepEqual(f.rebuild(), f.manifest)
  for (const id of ['gpu', 'cpu', 'angle']) assert.equal(f.manifest.sources[id].sha256, hash(f.archives[id]))
  fs.appendFileSync(path.join(f.output, f.manifest.sourceBundle.fileName), 'corruption')
  await assert.rejects(verifyLinuxSourceBundle(f.output, f.manifest), /source mismatch/)
})
test('portable source recipe excludes untracked files and nested workspace dependencies and rebuilds without Git', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-linux-recipe-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, 'checkout'), copied = path.join(root, 'copied'), restored = path.join(root, 'restored')
  write(source, 'package.json', { version: 'fixture' }); write(source, 'apps/desktop/source.ts', 'preferred source')
  write(source, 'apps/desktop/node_modules/generated.js', 'installed dependency'); write(source, 'private.env', 'not source material')
  for (const args of [['init', '--quiet'], ['add', 'package.json', 'apps/desktop/source.ts']]) assert.equal(spawnSync('git', args, { cwd: source }).status, 0)
  copyPortableRecipe(source, copied)
  assert.equal(fs.existsSync(path.join(copied, 'private.env')), false)
  assert.equal(fs.existsSync(path.join(copied, 'apps/desktop/node_modules')), false)
  copyPortableRecipe(copied, restored)
  assert.equal(fs.readFileSync(path.join(restored, 'apps/desktop/source.ts'), 'utf8'), 'preferred source')
  write(copied, '.javdex-source-files.json', ['../escape'])
  assert.throws(() => copyPortableRecipe(copied, path.join(root, 'unsafe')), /Unsafe/)
  assert.equal(fs.existsSync(path.join(root, 'unsafe')), false)
})
test('Linux release inventory refuses missing components, paths and omitted runtime hashes', async t => {
  const { manifest } = await fixture(t)
  for (const change of [m => { delete m.inventories.cpu }, m => { delete m.files['resources/linux-software-playback/libmpv.so.2'] },
    m => { m.files['../escape'] = 'a'.repeat(64) }, m => { m.sources.gpu.sha256 = 'b'.repeat(64) }]) {
    const value = structuredClone(manifest); change(value)
    assert.throws(() => validateLinuxInventory(value))
  }
})
for (const [label, id, mutate, expected] of [
  ['missing SDK', 'cpu', input => fs.rmSync(path.join(input, 'electron-sdk/include/node/node.h')), /ENOENT/],
  ['missing included native header', 'gpu', input => fs.rmSync(path.join(input, 'recipe/apps/desktop/src/main/player/native/generatedSubtitles.h'), { force: true }), /ENOENT/],
  ['missing required native build test', 'cpu', input => fs.rmSync(path.join(input, 'recipe/apps/desktop/src/main/player/native/linuxDmaBuf.test.cpp'), { force: true }), /ENOENT/],
  ['stale native helper', 'gpu', input => write(input, 'recipe/apps/desktop/src/main/player/native/linuxDmaBufPlayback.cpp', 'old helper'), /Stale Linux/],
  ['incomplete Ubuntu sources', 'cpu', input => fs.rmSync(path.join(input, 'fixture.tar.xz')), /ENOENT/],
  ['missing ANGLE preferred source', 'angle', input => fs.rmSync(path.join(input, 'angle/DEPS')), /ENOENT/],
  ['stale ANGLE recipe', 'angle', input => write(input, 'recipe/build/angle-args.gn', 'different args'), /ANGLE recipe/]
]) test(`Linux aggregation rejects ${label} despite refreshed outer bindings`, async t => {
  const f = await fixture(t); mutate(f.inputs[id])
  const manifest = await repack(f, id)
  await assert.rejects(verifyLinuxSourceBundle(f.output, manifest), expected)
  assert.ok(!fs.readdirSync(f.output).some(n => n.startsWith('.linux-source-check-')))
})
test('nested Linux archive traversal is rejected before extraction', async t => {
  const f = await fixture(t)
  await createTar({ cwd: f.inputs.cpu, file: f.archives.cpu, gzip: true, prefix: '../escape' }, ['fixture.tar.xz'])
  f.inventories.cpu.sourceBundle.sha256 = hash(f.archives.cpu)
  write(f.app, path.join(linuxReleaseComponents.cpu.directory, linuxReleaseComponents.cpu.manifest), f.inventories.cpu)
  await assert.rejects(verifyLinuxSourceBundle(f.output, f.rebuild()), /Unsafe/)
})
test('Linux resource gate checks target, every packaged byte, component inventory and source projection', async t => {
  const f = await fixture(t), resources = path.join(f.app, 'resources')
  // Native ELF inspectors are separately exercised on Linux. These substitutes
  // let all test hosts verify the actual projection/file/source-binding seam.
  const inspectors = {
    validateRuntime: directory => JSON.parse(fs.readFileSync(path.join(directory, 'portable-runtime.json'))),
    verifyAngle: () => f.inventories.angle
  }
  const target = { platformName: 'linux', archName: 'x64', electronVersion: 'fixture' }
  assert.deepEqual(verifyLinuxReleaseResources(resources, f.output, target, inspectors).manifest, f.manifest)
  assert.throws(() => verifyLinuxReleaseResources(resources, f.output, { ...target, electronVersion: 'other' }, inspectors))
  write(f.app, 'resources/linux-software-playback/libmpv.so.2', 'another library')
  assert.throws(() => verifyLinuxReleaseResources(resources, f.output, target, inspectors), /file mismatch/)
})
test('final Linux installers bind both closures and ANGLE, not just one legacy directory', async t => {
  const f = await fixture(t)
  for (const [name, target] of Object.entries(playbackInstallers(f.version))) if (target === 'linux-x64') write(f.output, name, 'installer ' + name)
  fs.cpSync(f.app, path.join(f.output, 'unpacked'), { recursive: true })
  let checked = 0
  const extract = (_file, directory) => { fs.cpSync(f.app, directory, { recursive: true }); return { root: directory, cleanup() {} } }
  const verify = resources => { checked++; return { manifest: JSON.parse(fs.readFileSync(linuxInventory(resources))) } }
  const host = { platform: 'linux', arch: 'x64' }
  verifyPlaybackInstallers(f.output, f.version, 'linux-x64', { extract, verify, host })
  assert.equal(checked, 2)
  for (const name of ['resources/linux-software-playback/libmpv.so.2', 'libEGL.so']) assert.throws(() =>
    verifyPlaybackInstallers(f.output, f.version, 'linux-x64', { extract(file, directory) {
      const value = extract(file, directory); write(directory, name, 'different build'); return value
    }, verify, host }), /runtime differs/)
})
