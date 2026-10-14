import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { playbackBuildFingerprint, playbackPkgConfigEnvironment, playbackSourceNativePlan, playbackSourcePlan, staticPlaybackDependencies, verifyPlaybackSource } from './playback-source-build.mjs'
import { mergeTargets } from './dist.mjs'
import packagingConfig from '../electron-builder.config.mjs'

const input = { arch: 'x64', source: '/sources', build: '/build', prefix: '/prefix', tools: '/tools', jobs: 2 }
test('release adapters explicitly choose MSVC/static CRT or runtime-local Linux loader paths', () => {
  const native = { root: '/repo', arch: 'x64', prefix: '/prefix', include: '/sdk/include', nodeLibrary: '/sdk/x64/node.lib', delayHook: '/node-gyp/hook.cc', output: '/output' }
  const windows = playbackSourceNativePlan({ ...native, platform: 'win32' })[0].args
  assert.equal(windows[windows.indexOf('-G') + 1], 'Visual Studio 17 2022')
  assert.ok(windows.includes('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'))
  const linux = playbackSourceNativePlan({ ...native, platform: 'linux' })[0].args
  assert.ok(linux.includes('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON'))
  assert.ok(linux.includes('-DCMAKE_INSTALL_RPATH=$ORIGIN'))
})
test('private pkgconf must retain private include/library flags for static library resolution', () => {
  const env = playbackPkgConfigEnvironment('/private-prefix', 'linux', 'x64')
  assert.equal(env.PKG_CONFIG_ALLOW_SYSTEM_LIBS, '1')
  assert.equal(env.PKG_CONFIG_ALLOW_SYSTEM_CFLAGS, '1')
  assert.equal(env.PKG_CONFIG_LIBDIR.split(path.delimiter)[0], '/private-prefix/lib/pkgconfig')
  assert.equal(env.PKG_CONFIG, '/private-prefix/bin/pkgconf')
})
test('source cache verifies both pinned size and digest, not just a filename', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'javdex-source-')), file = path.join(directory, 'source')
  writeFileSync(file, 'original')
  const source = { id: 'fixture', bytes: 8, sha256: createHash('sha256').update('original').digest('hex') }
  verifyPlaybackSource(file, source)
  writeFileSync(file, 'tampered'); assert.throws(() => verifyPlaybackSource(file, source), /digest mismatch/)
  writeFileSync(file, 'short'); assert.throws(() => verifyPlaybackSource(file, source), /size mismatch/)
})
test('compiled cache identity changes with source/recipe, SDK, compiler or architecture', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'javdex-fingerprint-')), file = path.join(directory, 'recipe')
  writeFileSync(file, 'original')
  const parameters = { platform: 'darwin', arch: 'arm64', electronVersion: '43.4.1', toolchain: 'clang-1', files: [file] }
  const fingerprint = playbackBuildFingerprint(parameters)
  assert.equal(playbackBuildFingerprint(parameters), fingerprint)
  for (const change of [{ arch: 'x64' }, { electronVersion: '43.5.0' }, { toolchain: 'clang-2' }])
    assert.notEqual(playbackBuildFingerprint({ ...parameters, ...change }), fingerprint)
  writeFileSync(file, 'changed'); assert.notEqual(playbackBuildFingerprint(parameters), fingerprint)
})
test('recipes build codecs/subtitles from source, disable implicit downloads and enable native audio/TLS', () => {
  for (const [platform, audio, tls] of [['darwin', '-Dcoreaudio=enabled', '--enable-securetransport'],
    ['win32', '-Dwasapi=enabled', '--enable-schannel'], ['linux', '-Dalsa=enabled', '--enable-openssl']]) {
    const plan = playbackSourcePlan({ ...input, platform })
    const commands = plan.flatMap(step => step.args)
    for (const id of ['libass', 'libplacebo', 'dav1d', 'mpv']) {
      const setup = plan.find(step => step.args.includes(path.join(input.source, id)))
      assert.ok(setup.args.includes('--wrap-mode=nodownload'))
      assert.ok(setup.args.includes('-Dauto_features=disabled'))
    }
    assert.ok(commands.includes('--enable-libdav1d'))
    assert.ok(commands.includes(`--pkg-config=${input.prefix}/bin/${platform === 'win32' ? 'pkgconf.exe' : 'pkgconf'}`), 'FFmpeg requires its explicit pkg-config argument, not the ignored PKG_CONFIG environment variable')
    assert.ok(commands.includes(tls)); assert.ok(commands.includes(audio))
    assert.ok(commands.includes('-Dplain-gl=enabled'))
    assert.ok(commands.includes('-Dlua=lua5.2'), 'native core must be able to explicitly disable load-scripts, ytdl and osc')
    assert.ok(!commands.includes('--disable-decoders'))
    assert.equal(commands.includes('no-shared'), platform === 'linux')
  }
  assert.throws(() => playbackSourcePlan({ ...input, platform: 'win32', arch: 'arm64' }), /architecture/)
})
test('static dependency patches fail on upstream recipe drift and leave OS ABIs alone', () => {
  const recipe = "dependency('libavcodec', version: '1')\ndependency('alsa')"
  const patched = staticPlaybackDependencies(recipe, ['libavcodec'])
  assert.match(patched, /dependency\('libavcodec', static: true/)
  assert.match(patched, /dependency\('alsa'\)/)
  assert.throws(() => staticPlaybackDependencies(recipe, ['missing']), /recipe drift/)
  assert.throws(() => staticPlaybackDependencies(recipe + recipe, ['libavcodec']), /recipe drift/)
})
test('native macOS packaging jobs select only their architecture without modifying the manifest', () => {
  const selected = [{ electronBuilder: { platform: 'mac', targets: [{ target: 'dmg', arch: ['arm64', 'x64'] }] } }]
  const original = JSON.stringify(selected)
  assert.deepEqual(mergeTargets(selected, 'x64'), { mac: [{ target: 'dmg', arch: ['x64'] }] })
  assert.deepEqual(mergeTargets(selected, 'arm64'), { mac: [{ target: 'dmg', arch: ['arm64'] }] })
  assert.deepEqual(mergeTargets(selected, 'ia32'), {})
  assert.equal(JSON.stringify(selected), original)
})
test('source lock contains full provenance and exact digests including required libplacebo submodules', () => {
  const lock = JSON.parse(readFileSync(new URL('../build/playback-sources.json', import.meta.url)))
  assert.equal(lock.schemaVersion, 1)
  assert.ok(lock.sources.some(source => source.id === 'fast_float'))
  assert.ok(lock.sources.some(source => source.id === 'vulkan_headers'))
  assert.equal(lock.sdk.electronVersion, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).devDependencies.electron)
  for (const source of [...lock.sources, ...lock.notices]) {
    assert.match(source.url, /^https:\/\//); assert.match(source.sha256, /^[0-9a-f]{64}$/)
    assert.ok(source.bytes > 0)
    if (source.licenseFiles) { assert.ok(source.licenseFiles.length > 0); assert.ok(source.version && source.license) }
  }
})
test('Debian package declares native OS prerequisites without replacing Electron defaults or requiring system mpv', () => {
  const dependencies = packagingConfig().deb.depends
  for (const name of ['libgtk-3-0', 'libnss3', 'libsecret-1-0', 'libasound2', 'libva2', 'libva-x11-2', 'libva-drm2', 'libxpresent1', 'libopengl0'])
    assert.ok(dependencies.includes(name))
  assert.ok(!dependencies.some(name => /mpv|ffmpeg/.test(name)))
})
