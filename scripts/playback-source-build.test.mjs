import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { playbackMpvRenderFenceFix, playbackBuildFingerprint, playbackLinuxAssDependency, playbackLinuxVaapiRenderDependency, playbackPkgConfigEnvironment, playbackSourceNativePlan, playbackSourcePlan, playbackWindowsExportNames, playbackWindowsSourceEnvironment, stageWindowsStaticZlib, staticPlaybackDependencies, verifyPlaybackSource } from './playback-source-build.mjs'
import { mergeTargets } from './dist.mjs'
import packagingConfig from '../electron-builder.config.mjs'

const input = { arch: 'x64', source: '/sources', build: '/build', prefix: '/prefix', tools: '/tools', jobs: 2 }

function windowsStaticFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'javdex-windows-static-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()))
    rmSync(root, { recursive: true, force: true })
  })
  mkdirSync(path.join(root, 'lib'))
  writeFileSync(path.join(root, 'lib/libzs.a'), '!<arch>\n')
  return root
}

test('static-only Windows zlib supplies the canonical -lz archive and refuses unrelated replacements', t => {
  const root = windowsStaticFixture(t)
  const result = stageWindowsStaticZlib(root)
  assert.deepEqual(readFileSync(path.join(root, result.source)), readFileSync(path.join(root, result.destination)))
  assert.deepEqual(stageWindowsStaticZlib(root), result)
  writeFileSync(path.join(root, 'lib/libz.a'), 'unrelated archive')
  assert.throws(() => stageWindowsStaticZlib(root), /different Windows zlib/)
})

test('Windows source linking retains a moved CRT fenv default only when the toolchain defines it', () => {
  for (const [symbols, expected] of [['00000000 R __mingw_fe_dfl_env\r\n', true], [' U __mingw_fe_dfl_env\n', false], ['', false]]) {
    const result = playbackWindowsSourceEnvironment('/prefix', symbols)
    assert.equal(result.fenvDefault, expected)
    assert.equal(result.linkArgs.includes('-Wl,--undefined=__mingw_fe_dfl_env'), expected)
  }
})

test('real MinGW source search and floating-point DLL survive the current CRT symbol layout', {
  skip: process.platform !== 'win32' || process.arch !== 'x64' || !process.env.JAVDEX_PLAYBACK_MSYS2_ROOT
    ? 'requires the configured Windows UCRT64 source-build toolchain' : false
}, t => {
  const root = windowsStaticFixture(t), tools = path.join(process.env.JAVDEX_PLAYBACK_MSYS2_ROOT, 'ucrt64/bin')
  stageWindowsStaticZlib(root)
  writeFileSync(path.join(root, 'lib/libiconv.a'), '!<arch>\n')
  const env = { ...process.env }, pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'Path'
  env[pathKey] = tools + path.delimiter + (env[pathKey] ?? '')
  const run = (name, args, overrides = {}) => {
    const r = spawnSync(path.join(tools, name), args, { encoding: 'utf8', env: { ...env, ...overrides }, timeout: 30000 })
    assert.equal(r.status, 0, `${name}: ${r.stderr || r.error?.message}`)
    return r.stdout.trim()
  }
  const runtime = run('gcc.exe', ['-print-file-name=libmingw32.a'])
  const symbols = run('nm.exe', ['--defined-only', '--extern-only', runtime])
  const windows = playbackWindowsSourceEnvironment(root, symbols)
  env.LIBRARY_PATH = windows.libraryPath
  for (const name of ['libiconv.a', 'libz.a']) assert.equal(path.resolve(run('gcc.exe', ['-print-file-name=' + name])), path.resolve(root, 'lib', name))
  const source = path.join(root, 'fenv.c'), dll = path.join(root, 'fenv.dll')
  writeFileSync(source, '#include <fenv.h>\n__declspec(dllexport) int probe(void) { fenv_t e; return fegetenv(&e) || fesetenv(&e); }\n')
  run('gcc.exe', ['-shared', source, '-o', dll, ...windows.linkArgs])
  run('python.exe', ['-c', 'import ctypes,sys; assert ctypes.CDLL(sys.argv[1]).probe() == 0', dll])
})

test('macOS release source plan builds the same sole Canvas producer as normal development', () => {
  for (const arch of ['x64', 'arm64']) {
    const steps = playbackSourceNativePlan({ ...input, platform: 'darwin', arch, root: '/repo', include: '/sdk', output: '/output' })
    const addon = steps.filter(step => step.command === 'clang++' && step.args.includes('-shared'))
    assert.equal(addon.length, 1)
    assert.ok(addon[0].args.includes(path.join('/repo', 'apps/desktop/src/main/player/native/macSharedTexture.mm')))
    assert.equal(addon[0].args.at(-1), path.join('/output', 'playback.node'))
    assert.ok(addon[0].args.includes('Foundation') && addon[0].args.includes('IOSurface'))
  }
})
test('Windows import library reads old and current GNU export name tables with LF or CRLF', () => {
  // Binutils peXXigen.c prints ordinal/base/hint columns in the current format.
  const tables = [
    '[Ordinal/Name Pointer] Table\n\t[   0] mpv_create\n\t[  10] mpv_render_context_create\n\t[  27] mpv_terminate_destroy\n\nThe Function Table',
    '[Ordinal/Name Pointer] Table -- Ordinal Base 1\n\t          Ordinal   Hint Name\n\t[   0] +base[   1]  0000 mpv_create\n\t[  10] +base[  11]  000a mpv_render_context_create\n\t[  27] +base[  28]  001b mpv_terminate_destroy\n\nThe Function Table'
  ]
  for (const table of tables)
    for (const newline of ['\n', '\r\n'])
      assert.deepEqual(playbackWindowsExportNames(table.replaceAll('\n', newline)), ['mpv_create', 'mpv_render_context_create', 'mpv_terminate_destroy'])
})
test('Windows import library only accepts safe libmpv names inside the export name table', () => {
  const table = [
    'Import table', '\t[   0] mpv_imported_only',
    'Export Address Table -- Ordinal Base 1', '\t[   0] +base[   1] 00008120 Forwarder RVA -- mpv_forwarded',
    '[Ordinal/Name Pointer] Table -- Ordinal Base 1', '\t          Ordinal   Hint Name',
    '\t[   0] +base[   1]  0000 mpv_create',
    '\t[   1] +base[   2]  0001 other_api', '\t[   2] +base[   3]  0002 mpv_unsafe.name',
    '\t[   3] +base[   4]  0003 mpv_bad-name', '\t[   4] +base[   5]  0004 mpv_bad extra',
    '\t[   5] +base[   6]  0005 <corrupt offset: ffffffff>',
    '', 'The Function Table', '\t[   6] mpv_outside_table'
  ].join('\n')
  assert.deepEqual(playbackWindowsExportNames(table), ['mpv_create'])
  assert.deepEqual(playbackWindowsExportNames('\t[   0] mpv_create\n'), [])
})
test('Windows source entrypoint uses the action installation rather than a second preinstalled MSYS', () => {
  const msys = 'D:\\a\\_temp\\msys64', expectedShell = path.win32.join(msys, 'usr/bin/bash.exe')
  const bootstrap = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    Object.defineProperty(process, 'platform', { value: 'win32' })
    Object.defineProperty(process, 'arch', { value: 'x64' })
    process.env.JAVDEX_PLAYBACK_MSYS2_ROOT = ${JSON.stringify(msys)}
    delete process.env.pythonLocation
    delete process.env.GITHUB_OUTPUT
    const exists = fs.existsSync
    fs.existsSync = file => String(file).startsWith(${JSON.stringify(msys)}) || exists(file)
    childProcess.spawnSync = (command, args, options) => {
      assert.equal(command, ${JSON.stringify(expectedShell)}, 'source commands must use the installed MSYS shell')
      const key = Object.keys(options.env).find(key => key.toLowerCase() === 'path')
      assert.ok(options.env[key].startsWith(${JSON.stringify(path.win32.join(msys, 'ucrt64/bin'))}))
      return { status: 0, stdout: 'fixture-tool-version', stderr: '' }
    }
    syncBuiltinESMExports()
    process.argv.push('--fingerprint')
    await import('./scripts/build-playback-runtime.mjs')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^[a-f0-9]{64}\s*$/)
})
test('release adapters explicitly choose MSVC/static CRT or runtime-local Linux loader paths', () => {
  const native = { root: '/repo', arch: 'x64', prefix: '/prefix', include: '/sdk/include', nodeLibrary: '/sdk/x64/node.lib', delayHook: '/node-gyp/hook.cc', output: '/output' }
  const windows = playbackSourceNativePlan({ ...native, platform: 'win32' })[0].args
  assert.equal(windows[windows.indexOf('-G') + 1], 'Visual Studio 17 2022')
  assert.ok(windows.includes('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'))
  const linux = playbackSourceNativePlan({ ...native, platform: 'linux' })[0].args
  assert.ok(linux.includes('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON'))
  assert.ok(linux.includes('-DCMAKE_INSTALL_RPATH=$ORIGIN'))
})
test('Linux source adapter tests use the private library prefix before runtime relocation only', () => {
  const native = { root: '/repo', arch: 'x64', prefix: '/private-prefix', include: '/sdk/include', nodeLibrary: '/sdk/x64/node.lib', delayHook: '/node-gyp/hook.cc', output: '/output' }
  const linux = playbackSourceNativePlan({ ...native, platform: 'linux' })
  for (const step of linux) {
    assert.deepEqual(step.env, step.command === 'cmake' ? undefined : { LD_LIBRARY_PATH: path.join(native.prefix, 'lib') })
  }
  for (const platform of ['win32', 'darwin'])
    assert.ok(playbackSourceNativePlan({ ...native, platform }).every(step => !step.env))
})
test('Windows static pkgconf declares static API for both its library and CLI without changing codec flags', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const plan = playbackSourcePlan({ ...input, platform })
    const configure = plan.find(step => step.command === 'sh' && step.cwd === path.join(input.build, 'pkgconf'))
    assert.equal(configure.args.includes('CPPFLAGS=-DPKGCONFIG_IS_STATIC'), platform === 'win32')
    assert.ok(plan.filter(step => step !== configure).every(step => !step.args.some(arg => arg.includes('PKGCONFIG_IS_STATIC'))))
  }
})
test('Windows mpv explicitly retains its native thread backend with optional autodetection disabled', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const setup = playbackSourcePlan({ ...input, platform }).find(step => step.args.includes(path.join(input.source, 'mpv')))
    assert.ok(setup.args.includes('-Dauto_features=disabled'))
    assert.equal(setup.args.includes('-Dwin32-threads=enabled'), platform === 'win32')
  }
})
test('private pkgconf must retain private include/library flags for static library resolution', () => {
  const env = playbackPkgConfigEnvironment('/private-prefix', 'linux', 'x64')
  assert.equal(env.PKG_CONFIG_ALLOW_SYSTEM_LIBS, '1')
  assert.equal(env.PKG_CONFIG_ALLOW_SYSTEM_CFLAGS, '1')
  assert.equal(env.PKG_CONFIG_LIBDIR.split(path.delimiter)[0], path.join('/private-prefix', 'lib/pkgconfig'))
  assert.equal(env.PKG_CONFIG, path.join('/private-prefix', 'bin/pkgconf'))
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
    ['win32', '-Dwasapi=enabled', '--enable-schannel'], ['linux', '-Dpulse=enabled', '--enable-openssl']]) {
    const plan = playbackSourcePlan({ ...input, platform })
    const commands = plan.flatMap(step => step.args)
    for (const id of ['libass', 'libplacebo', 'dav1d', 'mpv']) {
      const setup = plan.find(step => step.args.includes(path.join(input.source, id)))
      assert.ok(setup.args.includes('--wrap-mode=nodownload'))
      assert.ok(setup.args.includes('-Dauto_features=disabled'))
    }
    assert.ok(commands.includes('--enable-libdav1d'))
    assert.ok(commands.includes(`--pkg-config=${path.join(input.prefix, 'bin', platform === 'win32' ? 'pkgconf.exe' : 'pkgconf')}`), 'FFmpeg requires its explicit pkg-config argument, not the ignored PKG_CONFIG environment variable')
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
test('Linux libass retains private static link flags without recursively selecting non-PIC OS archives', () => {
  const before = "libass = dependency('libass', static: true, version: '>= 0.12.2')"
  const after = playbackLinuxAssDependency(before, '/private-prefix/bin/pkgconf')
  assert.match(after, /partial_dependency\(compile_args: true, includes: true\)/)
  assert.match(after, /'--libs-only-l', '--libs-only-other', '--static', 'libass'/)
  assert.ok(after.includes("find_program('/private-prefix/bin/pkgconf')"))
  assert.throws(() => playbackLinuxAssDependency('dependency has changed', '/pkgconf'), /recipe drift/)
  assert.throws(() => playbackLinuxAssDependency(before + before, '/pkgconf'), /recipe drift/)
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

test('Dedicated Linux DMA-BUF profile excludes window-system outputs and uses Pulse protocol', () => {
  const plan = playbackSourcePlan({ ...input, platform: 'linux', linuxProfile: 'dmabuf' })
  const mpv = plan.find(s => s.args[0] === 'setup' && s.args.includes(path.join('/sources', 'mpv')))
  for (const flag of ['-Dplain-gl=enabled', '-Dpulse=enabled', '-Dalsa=disabled', '-Dx11=disabled', '-Dgl-x11=disabled', '-Dvaapi=enabled', '-Dvaapi-x11=disabled', '-Dvaapi-drm=enabled']) assert.ok(mpv.args.includes(flag), flag)
  const defaults = playbackSourcePlan({ ...input, platform: 'linux' }).find(s => s.args[0] === 'setup' && s.args.includes(path.join('/sources', 'mpv')))
  assert.ok(defaults.args.includes('-Dx11=disabled'))
  assert.throws(() => playbackSourcePlan({ ...input, platform: 'linux', linuxProfile: 'x11' }), /Unsupported Linux playback profile/)
  assert.throws(() => playbackSourcePlan({ ...input, platform: 'darwin', linuxProfile: 'dmabuf' }), /requires Linux/)
})

test('VAAPI render dependency patch removes only the native KMS prerequisite', () => {
  const recipe = "get_option('vaapi-drm').require(libva.found() and features['drm'])"
  assert.equal(playbackLinuxVaapiRenderDependency(recipe), "get_option('vaapi-drm').require(libva.found())")
  assert.throws(() => playbackLinuxVaapiRenderDependency('changed upstream recipe'), /recipe drift/)
})

test('CPU profile disables graphics rendering and hardware decoding while retaining Pulse audio', () => {
  const steps = playbackSourcePlan({ platform: 'linux', arch: 'x64', source: '/src', build: '/build', prefix: '/prefix', tools: '/tools', jobs: 2, linuxProfile: 'software' })
  const ff = steps.find(s => s.args.includes(path.join('/src', 'ffmpeg/configure'))).args
  assert(ff.includes('--disable-vaapi')); assert(ff.includes('--disable-hwaccels'))
  const mpv = steps.find(s => s.args.includes(path.join('/src', 'mpv'))).args
  for (const flag of ['-Dgl=disabled', '-Dplain-gl=disabled', '-Dvaapi=disabled', '-Dpulse=enabled', '-Dx11=disabled']) assert(mpv.includes(flag))
})

test('Linux GPU enables NVDEC copy support from pinned headers without contaminating CPU or other platforms', () => {
  for (const profile of ['dmabuf', 'software']) {
    const steps = playbackSourcePlan({ ...input, platform: 'linux', linuxProfile: profile })
    const ff = steps.find(s => s.args.includes(path.join('/sources', 'ffmpeg/configure'))).args
    const mpv = steps.find(s => s.args[0] === 'setup' && s.args.includes(path.join('/sources', 'mpv'))).args
    const install = steps.find(s => s.cwd === path.join('/sources', 'nv_codec_headers'))
    assert.equal(Boolean(install), profile === 'dmabuf')
    assert(ff.includes(profile === 'dmabuf' ? '--enable-nvdec' : '--disable-nvdec'))
    assert(ff.includes(profile === 'dmabuf' ? '--enable-ffnvcodec' : '--disable-ffnvcodec'))
    assert(mpv.includes(profile === 'dmabuf' ? '-Dcuda-hwaccel=enabled' : '-Dcuda-hwaccel=disabled'))
    assert(mpv.includes(profile === 'dmabuf' ? '-Dcuda-interop=enabled' : '-Dcuda-interop=disabled'))
  }
  for (const platform of ['darwin', 'win32']) {
    const steps = playbackSourcePlan({ ...input, platform })
    assert(!steps.some(s => s.cwd === path.join('/sources', 'nv_codec_headers')))
  }
})

test('mpv fence backport preserves native swapchain and rejects source drift', () => {
  const source = '    if (gl->FenceSync) {\n        GLsync fence = gl->FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);\n        if (fence) append(fence);\n    }'
  const fixed = playbackMpvRenderFenceFix(source)
  assert.equal(fixed, source.replace('if (gl->FenceSync)', 'if (gl->FenceSync && p->params.swap_buffers)'))
  for (const changed of ['', source + source, fixed]) assert.throws(() => playbackMpvRenderFenceFix(changed), /source drift/)
})
