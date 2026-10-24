import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { c as createTar, x as extractTar } from 'tar'
import test from 'node:test'
import { aggregatePlaybackSources, splitSourceTar } from './aggregate-playback-sources.mjs'
import { restorePlatform, sha256, safePath } from './restore-playback-sources.mjs'
import { linuxReleaseFixture } from './test-support/linux-release-fixture.mjs'

const version = '0.9.0'
const targetNames = ['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64']
const names = ['windows-x64', 'macos-x64', 'macos-arm64', 'linux-x64']
const packagingFiles = ['scripts/playback-runtime.mjs', 'scripts/playback-source-materials.mjs', 'scripts/packaging-runtime.mjs', 'scripts/dist.mjs',
  'electron-builder.config.mjs', 'build/packaging.targets.json', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE']
function write(root, name, bytes) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
  fs.writeFileSync(path.join(root, name), bytes)
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-combined-sources-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const inputs = []
  const directory = path.join(root, 'release'); fs.mkdirSync(directory)
  for (const [i, target] of targetNames.entries()) {
    const input = path.join(root, target)
    const upstream = path.join(root, 'upstream-' + i)
    write(upstream, 'mpv-fixture.tar.gz', 'same preferred mpv source')
    write(upstream, 'ffmpeg-fixture.tar.xz', i === 3 ? 'different ffmpeg version' : 'shared ffmpeg source')
    const tar = path.join(root, 'nested-' + i + '.tar')
    await createTar({ cwd: upstream, file: tar, portable: true }, ['mpv-fixture.tar.gz', 'ffmpeg-fixture.tar.xz'])
    const sourcePins = ['mpv-fixture.tar.gz', 'ffmpeg-fixture.tar.xz'].map(filename => ({
      id: filename.startsWith('mpv') ? 'mpv' : 'ffmpeg', version: 'fixture', filename,
      bytes: fs.statSync(path.join(upstream, filename)).size, sha256: sha256(fs.readFileSync(path.join(upstream, filename)))
    }))
    const sdk = { electronVersion: 'test', nodeVersion: '1.2.3' }
    const native = path.join(root, 'native-' + i)
    for (const name of ['LICENSE', 'NOTICE', 'scripts/build-playback-runtime.mjs', 'scripts/playback-source-build.mjs',
      'scripts/playback-runtime.mjs', 'scripts/playback-source-materials.mjs', 'scripts/packaging-runtime.mjs',
      'scripts/playback-native-build.mjs', 'scripts/check-playback-load.mjs', 'scripts/playback-linux-helper-smoke.mjs',
      'apps/desktop/src/main/player/native/CMakeLists.txt', 'apps/desktop/src/main/player/native/mpvCore.h',
      'apps/desktop/src/main/player/native/windowsPlayback.cpp', 'apps/desktop/src/main/player/native/macSharedTexture.mm',
      'apps/desktop/src/main/player/native/windowsSharedTexture.cpp', 'apps/desktop/src/main/player/native/windowsSoftwarePlayback.cpp', 'apps/desktop/src/main/player/native/windowsTextureTickets.h',
      'apps/desktop/src/main/player/native/windowsTextureTickets.test.cpp',
      'apps/desktop/src/main/player/native/linuxX11Playback.cpp', 'electron-sdk/include/node/node.h', 'win_delay_load_hook.cc', 'node-gyp-LICENSE']) write(native, name, 'fixture ' + name)
    write(native, 'package.json', JSON.stringify({ version }))
    write(native, 'package-lock.json', JSON.stringify({ version }))
    write(native, 'build/playback-sources.json', JSON.stringify({ sdk, sources: sourcePins }))
    write(native, 'electron-sdk/include/node/node_version.h', '#define NODE_MAJOR_VERSION 1\n#define NODE_MINOR_VERSION 2\n#define NODE_PATCH_VERSION 3\n')
    const nativeTar = path.join(root, 'native-' + i + '.tar.gz')
    await createTar({ cwd: native, file: nativeTar, gzip: true }, ['.'])
    const payload = { 'sources/libmpv-sources.tar': fs.readFileSync(tar), 'sources/javdex-native.tar.gz': fs.readFileSync(nativeTar),
      'licenses/libmpv.txt': Buffer.from('upstream licenses'), 'licenses/javdex.txt': Buffer.from('native license'),
      'build.json': Buffer.from(JSON.stringify({ platform: target.split('-')[0], arch: target.split('-')[1],
        commands: ['patch ' + i], toolchain: 'compiler-' + i,
        sdk, sources: sourcePins })) }
    for (const [name, bytes] of Object.entries(payload)) write(input, 'reviewed-runtime/' + name, bytes)
    const [platform, arch] = target.split('-')
    const entry = platform === 'linux' ? 'playback-helper' : 'playback.node'
    const runtime = { schemaVersion: 1, hashStage: 'pre-sign', platform, arch, electronVersion: 'test', mpvVersion: 'fixture',
      files: { ...Object.fromEntries(Object.entries(payload).map(([name, bytes]) => [name, sha256(bytes)])),
        [entry]: sha256(Buffer.from(target)), 'mpv.dll': sha256(Buffer.from('library-' + i)) },
      components: [{ name: 'mpv', version: 'fixture', binaries: ['mpv.dll'], licenseFile: 'licenses/libmpv.txt', sourceArchive: 'sources/libmpv-sources.tar', buildRecipe: 'build.json' },
        { name: 'javdex-native', version, binaries: [entry], licenseFile: 'licenses/javdex.txt', sourceArchive: 'sources/javdex-native.tar.gz', buildRecipe: 'build.json' }] }
    write(input, 'reviewed-runtime/runtime.json', JSON.stringify(runtime))
    const tools = createHash('sha256')
    for (const name of packagingFiles) {
      const bytes = name === 'package.json' ? JSON.stringify({ version }) : 'fixture packaging ' + name
      write(input, 'packaging-tools/' + name, bytes)
      tools.update(name + '\0').update(bytes)
    }
    write(input, 'README.txt', 'fixture rebuilding instructions')
    const archive = `Javdex-Playback-Sources-${version}-${target}-fixture.tar.gz`
    await createTar({ cwd: input, file: path.join(directory, archive), gzip: true }, ['reviewed-runtime', 'packaging-tools', 'README.txt'])
    const binding = { fileName: archive, sha256: sha256(fs.readFileSync(path.join(directory, archive))),
      inputInventorySha256: sha256(fs.readFileSync(path.join(input, 'reviewed-runtime/runtime.json'))), packagingToolsSha256: tools.digest('hex') }
    write(directory, archive + '.runtime.json', JSON.stringify({ ...runtime, sourceBundle: binding }))
    inputs.push({ input, archive, payload, binding })
  }
  for (const name of [`Javdex-Setup-${version}-x64.exe`, `Javdex-Setup-${version}-x64.zip`,
    `Javdex-${version}-x64.dmg`, `Javdex-${version}-arm64.dmg`, `Javdex-${version}-amd64.deb`, `Javdex-${version}-x86_64.AppImage`]) write(directory, name, 'fixture installer ' + name)
  for (const [i, target] of names.entries()) {
    const expected = i === 0 ? [`Javdex-Setup-${version}-x64.exe`, `Javdex-Setup-${version}-x64.zip`] : i === 1
      ? [`Javdex-${version}-x64.dmg`] : i === 2 ? [`Javdex-${version}-arm64.dmg`]
        : [`Javdex-${version}-amd64.deb`, `Javdex-${version}-x86_64.AppImage`]
    write(directory, inputs[i].archive + '.installers.json', JSON.stringify({ schemaVersion: 1, target, version,
      sourceBundle: inputs[i].binding, installers: Object.fromEntries(expected.map(name => [name, {
        sha256: sha256(fs.readFileSync(path.join(directory, name))),
        runtimeInventorySha256: sha256(fs.readFileSync(path.join(directory, inputs[i].archive + '.runtime.json')))
      }])) }))
  }
  return { root, directory, inputs }
}
function refreshProof(f, index) {
  const archive = f.inputs[index].archive
  const sidecar = path.join(f.directory, archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar))
  const file = path.join(f.directory, archive + '.installers.json')
  const proof = JSON.parse(fs.readFileSync(file))
  proof.sourceBundle = value.sourceBundle
  for (const item of Object.values(proof.installers)) item.runtimeInventorySha256 = sha256(fs.readFileSync(sidecar))
  fs.writeFileSync(file, JSON.stringify(proof))
}

test('one combined archive deduplicates content, retains variants and restores all four platform inputs', async t => {
  const f = await fixture(t)
  const combined = await aggregatePlaybackSources(f.directory, version)
  const unpacked = path.join(f.root, 'combined'); fs.mkdirSync(unpacked)
  await extractTar({ cwd: unpacked, file: combined })
  const bundle = path.join(unpacked, 'Playback-Sources')
  assert.equal(fs.readdirSync(path.dirname(combined)).length, 1)
  assert.equal(fs.readdirSync(path.join(bundle, 'sources/mpv')).length, 1, 'shared mpv retained once')
  assert.equal(fs.readdirSync(path.join(bundle, 'sources/ffmpeg')).length, 2, 'same name/different bytes not merged')
  for (const [i, target] of names.entries()) {
    const restored = path.join(f.root, 'restored-' + target)
    restorePlatform(bundle, target, restored)
    for (const name of [...Object.keys(f.inputs[i].payload), 'runtime.json'])
      assert.deepEqual(fs.readFileSync(path.join(restored, 'reviewed-runtime', name)), fs.readFileSync(path.join(f.inputs[i].input, 'reviewed-runtime', name)))
    const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifests', target + '.json')))
    assert.equal(manifest.installers.length, i === 0 || i === 3 ? 2 : 1)
    assert.ok(fs.existsSync(path.join(restored, 'packaging-tools/scripts/dist.mjs')))
    assert.throws(() => restorePlatform(bundle, target, restored), /new directory/)
  }
  const mpvFile = path.join(bundle, 'sources/mpv', fs.readdirSync(path.join(bundle, 'sources/mpv'))[0])
  fs.writeFileSync(mpvFile, 'corrupt source')
  assert.throws(() => restorePlatform(bundle, names[0], path.join(f.root, 'corrupt-restore')), /digest mismatch/)
  assert.equal(fs.existsSync(path.join(f.root, 'corrupt-restore')), false)
})

test('aggregation rejects missing platforms and tampered input archives', async t => {
  const f = await fixture(t)
  const archive = path.join(f.directory, f.inputs[0].archive)
  fs.renameSync(archive, archive + '.missing')
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /four platform/)
  fs.renameSync(archive + '.missing', archive)
  const sidecar = path.join(f.directory, f.inputs[0].archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar)); value.sourceBundle.sha256 = '0'.repeat(64)
  fs.writeFileSync(sidecar, JSON.stringify(value))
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /AssertionError/)
})

test('aggregation rejects binary/source binding mismatches', async t => {
  const f = await fixture(t)
  const sidecar = path.join(f.directory, f.inputs[0].archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar)); value.files['playback.node'] = '0'.repeat(64)
  fs.writeFileSync(sidecar, JSON.stringify(value))
  refreshProof(f, 0)
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /binary binding mismatch/)
})

test('aggregation refuses incomplete component evidence even with a matching outer archive hash', async t => {
  const f = await fixture(t)
  const { input, archive } = f.inputs[0]
  fs.unlinkSync(path.join(input, 'reviewed-runtime/build.json'))
  await createTar({ cwd: input, file: path.join(f.directory, archive), gzip: true }, ['reviewed-runtime', 'packaging-tools', 'README.txt'])
  const sidecar = path.join(f.directory, archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar))
  value.sourceBundle.sha256 = sha256(fs.readFileSync(path.join(f.directory, archive)))
  fs.writeFileSync(sidecar, JSON.stringify(value))
  refreshProof(f, 0)
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /ENOENT/)
})

test('duplicate targets cannot replace a missing architecture', async t => {
  const f = await fixture(t)
  const { input, archive } = f.inputs[1]
  const runtimePath = path.join(input, 'reviewed-runtime/runtime.json')
  const runtime = JSON.parse(fs.readFileSync(runtimePath)); runtime.arch = 'arm64'
  fs.writeFileSync(runtimePath, JSON.stringify(runtime))
  await createTar({ cwd: input, file: path.join(f.directory, archive), gzip: true }, ['reviewed-runtime', 'packaging-tools', 'README.txt'])
  const sidecar = path.join(f.directory, archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar)); value.arch = 'arm64'
  value.sourceBundle.inputInventorySha256 = sha256(fs.readFileSync(runtimePath))
  value.sourceBundle.sha256 = sha256(fs.readFileSync(path.join(f.directory, archive)))
  fs.writeFileSync(sidecar, JSON.stringify(value))
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /Duplicate\/unsupported/)
})

test('aggregate checks source version and complete installer matrix', async t => {
  const f = await fixture(t)
  await assert.rejects(aggregatePlaybackSources(f.directory, 'wrong-version'), /version/)
  fs.unlinkSync(path.join(f.directory, `Javdex-${version}-arm64.dmg`))
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /six desktop/)
})

test('source paths and malformed tar containers fail closed', () => {
  for (const name of ['../outside', '/absolute', 'x\\y', 'x:y']) assert.throws(() => safePath(name))
  assert.throws(() => splitSourceTar(Buffer.from('truncated'), () => {}), /Truncated/)
})

test('escaping source tar rejects its promise and cleans aggregation staging', async t => {
  const f = await fixture(t)
  const { input, archive } = f.inputs[2]
  await createTar({ cwd: input, file: path.join(f.directory, archive), gzip: true, prefix: '../outside' }, ['README.txt'])
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /Unsafe/)
  assert.ok(!fs.readdirSync(f.directory).some(name => name.startsWith('.playback-source-aggregate-')))
})

test('changed final installer cannot reuse a native-runner verification receipt', async t => {
  const f = await fixture(t)
  fs.writeFileSync(path.join(f.directory, `Javdex-Setup-${version}-x64.exe`), 'another build under the same name')
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /Final installer digest/)
})

test('opaque native blob is rejected even when all outer digests and receipts agree', async t => {
  const f = await fixture(t), index = 0
  const { input, archive } = f.inputs[index]
  const source = 'sources/javdex-native.tar.gz'
  write(input, 'reviewed-runtime/' + source, 'not a reconstructable native archive')
  const runtimeFile = path.join(input, 'reviewed-runtime/runtime.json')
  const runtime = JSON.parse(fs.readFileSync(runtimeFile))
  runtime.files[source] = sha256(fs.readFileSync(path.join(input, 'reviewed-runtime', source)))
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime))
  await createTar({ cwd: input, file: path.join(f.directory, archive), gzip: true }, ['reviewed-runtime', 'packaging-tools', 'README.txt'])
  const sidecar = path.join(f.directory, archive + '.runtime.json')
  const value = JSON.parse(fs.readFileSync(sidecar))
  value.files[source] = runtime.files[source]
  value.sourceBundle.inputInventorySha256 = sha256(fs.readFileSync(runtimeFile))
  value.sourceBundle.sha256 = sha256(fs.readFileSync(path.join(f.directory, archive)))
  fs.writeFileSync(sidecar, JSON.stringify(value)); refreshProof(f, index)
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /archive|TAR|gzip/i)
  assert.ok(!fs.readdirSync(f.directory).some(name => name.startsWith('.playback-source-aggregate-')))
})

test('integrated Linux and three native targets share one public source archive with exact restoration', async t => {
  const f = await fixture(t), linuxRoot = path.join(f.root, 'integrated-linux')
  fs.mkdirSync(linuxRoot)
  const linux = await linuxReleaseFixture(linuxRoot, version)
  for (const suffix of ['', '.runtime.json', '.installers.json']) fs.unlinkSync(path.join(f.directory, f.inputs[3].archive + suffix))
  const name = linux.manifest.sourceBundle.fileName
  for (const suffix of ['', '.runtime.json']) fs.copyFileSync(path.join(linux.output, name + suffix), path.join(f.directory, name + suffix))
  const installers = [`Javdex-${version}-amd64.deb`, `Javdex-${version}-x86_64.AppImage`]
  write(f.directory, name + '.installers.json', JSON.stringify({ schemaVersion: 1, target: 'linux-x64', version,
    sourceBundle: linux.manifest.sourceBundle, installers: Object.fromEntries(installers.map(n => [n, {
      sha256: sha256(fs.readFileSync(path.join(f.directory, n))), runtimeInventorySha256: sha256(fs.readFileSync(path.join(f.directory, name + '.runtime.json')))
    }])) }))
  const combined = await aggregatePlaybackSources(f.directory, version)
  const extracted = path.join(f.root, 'integrated-combined'); fs.mkdirSync(extracted)
  await extractTar({ cwd: extracted, file: combined })
  const restored = path.join(f.root, 'restored-integrated-linux')
  restorePlatform(path.join(extracted, 'Playback-Sources'), 'linux-x64', restored)
  for (const id of ['gpu', 'cpu', 'angle']) assert.deepEqual(fs.readFileSync(path.join(restored, 'reviewed-runtime/sources', id + '.tar.gz')), fs.readFileSync(linux.archives[id]))
  const manifest = JSON.parse(fs.readFileSync(path.join(extracted, 'Playback-Sources/manifests/linux-x64.json')))
  assert.equal(manifest.runtime.kind, 'linux-integrated'); assert.equal(manifest.installers.length, 2)
  assert.ok(fs.existsSync(path.join(restored, 'packaging-tools/scripts/linux-integrated-playback.mjs')))
  fs.writeFileSync(path.join(f.directory, installers[1]), 'changed installer')
  fs.rmSync(path.dirname(combined), { recursive: true })
  await assert.rejects(aggregatePlaybackSources(f.directory, version), /Final installer digest/)
})
