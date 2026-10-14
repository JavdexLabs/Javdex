// Release source build plan. OS compiler/SDK/display/audio/driver ABIs are
// prerequisites; no package-manager codec or Homebrew libmpv enters this plan.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { playbackNativeBuild } from './playback-native-build.mjs'

export function verifyPlaybackSource(file, source) {
  assert.equal(statSync(file).size, source.bytes, `Source size mismatch: ${source.id}`)
  assert.equal(playbackFileSha256(file), source.sha256, `Source digest mismatch: ${source.id}`)
}

export function playbackPkgConfigEnvironment(prefix, platform, arch) {
  return {
    PKG_CONFIG: path.join(prefix, 'bin', platform === 'win32' ? 'pkgconf.exe' : 'pkgconf'),
    PKG_CONFIG_PATH: path.join(prefix, 'lib/pkgconfig'),
    PKG_CONFIG_LIBDIR: [path.join(prefix, 'lib/pkgconfig'), ...(platform === 'linux' ? [
      `/usr/lib/${arch === 'x64' ? 'x86_64' : 'aarch64'}-linux-gnu/pkgconfig`, '/usr/lib/pkgconfig', '/usr/share/pkgconfig'] : [])].join(path.delimiter),
    // pkgconf is itself installed in the private prefix. It otherwise removes
    // that -L/-I as "system" paths, causing Meson to choose host static FFmpeg.
    PKG_CONFIG_ALLOW_SYSTEM_LIBS: '1', PKG_CONFIG_ALLOW_SYSTEM_CFLAGS: '1'
  }
}

export function playbackBuildFingerprint({ platform, arch, electronVersion, toolchain, files }) {
  const hash = createHash('sha256').update(JSON.stringify({ platform, arch, electronVersion, toolchain }))
  for (const file of [...files].sort()) hash.update(file).update(readFileSync(file))
  return hash.digest('hex')
}

export function playbackSourceNativePlan(input) {
  const steps = playbackNativeBuild(input)
  if (input.platform === 'win32') {
    // Dependency builds use MinGW, but the addon deliberately uses MSVC and
    // its Electron delay-load hook. Never inherit a MinGW/Ninja default here.
    steps[0].args.push('-G', 'Visual Studio 17 2022', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded')
  } else if (input.platform === 'linux') {
    steps[0].args.push('-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', '-DCMAKE_INSTALL_RPATH=$ORIGIN')
    // Tests run before libmpv is relocated beside the helper. Their loader
    // environment must not leak into the later runtime/package acceptance.
    for (const step of steps.filter(step => step.command !== 'cmake'))
      step.env = { LD_LIBRARY_PATH: path.join(input.prefix, 'lib') }
  }
  return steps
}

export function playbackSourcePlan({ platform, arch, source, build, prefix, tools, jobs }) {
  assert.ok(['darwin', 'linux', 'win32'].includes(platform), 'Unsupported playback host')
  assert.ok(['x64', 'arm64'].includes(arch) && (platform !== 'win32' || arch === 'x64'), 'Unsupported playback architecture')
  const steps = [], dir = id => path.join(source, id), output = id => path.join(build, id)
  const step = (command, args, cwd) => steps.push({ command, args, cwd })
  const make = cwd => { step('make', [`-j${jobs}`], cwd); step('make', ['install'], cwd) }
  const configure = (id, options = []) => { step('sh', [path.join(dir(id), 'configure'), `--prefix=${prefix}`, ...options], output(id)); make(output(id)) }
  const meson = (id, options = [], library = 'static') => {
    step(path.join(tools, 'meson'), ['setup', output(id), dir(id), `--prefix=${prefix}`, '--libdir=lib', '--buildtype=release', '--wrap-mode=nodownload',
      '-Db_staticpic=true', '-Dauto_features=disabled', `-Ddefault_library=${library}`, ...options])
    step(path.join(tools, 'meson'), ['compile', '-C', output(id), '-j', String(jobs)])
    step(path.join(tools, 'meson'), ['install', '-C', output(id)])
  }
  const cmake = (id, options) => {
    step('cmake', ['-S', dir(id), '-B', output(id), '-G', 'Ninja', `-DCMAKE_INSTALL_PREFIX=${prefix}`, '-DCMAKE_INSTALL_LIBDIR=lib',
      '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', ...options])
    step('cmake', ['--build', output(id), '--parallel', String(jobs)])
    step('cmake', ['--install', output(id)])
  }
  configure('pkgconf', ['--disable-shared', '--enable-static', '--with-pkg-config-dir=',
    ...(platform === 'win32' ? ['CPPFLAGS=-DPKGCONFIG_IS_STATIC'] : [])])
  cmake('zlib', ['-DZLIB_BUILD_SHARED=OFF', '-DZLIB_BUILD_STATIC=ON', '-DZLIB_BUILD_TESTING=OFF'])
  cmake('freetype', ['-DBUILD_SHARED_LIBS=OFF', '-DFT_DISABLE_ZLIB=TRUE', '-DFT_DISABLE_BZIP2=TRUE', '-DFT_DISABLE_PNG=TRUE', '-DFT_DISABLE_HARFBUZZ=TRUE', '-DFT_DISABLE_BROTLI=TRUE'])
  meson('fribidi', ['-Ddocs=false', '-Dbin=false', '-Dtests=false'])
  meson('harfbuzz', ['-Dtests=disabled', '-Dutilities=disabled', '-Dsubset=disabled', '-Draster=disabled', '-Dvector=disabled', '-Dgpu=disabled'])
  configure('libunibreak', ['--disable-shared', '--enable-static'])
  if (platform === 'win32') configure('libiconv', ['--disable-shared', '--enable-static'])
  meson('libass', ['-Dlibunibreak=enabled', `-D${{ darwin: 'coretext', win32: 'directwrite', linux: 'fontconfig' }[platform]}=enabled`,
    `-Dasm=${arch === 'x64' ? 'enabled' : 'disabled'}`])
  meson('libplacebo', ['-Ddemos=false', '-Ddovi=enabled'])
  meson('dav1d', ['-Denable_tools=false', '-Denable_tests=false'])
  if (platform === 'linux') {
    step('perl', [path.join(dir('openssl'), 'Configure'), arch === 'x64' ? 'linux-x86_64' : 'linux-aarch64', `--prefix=${prefix}`,
      '--openssldir=/etc/ssl', '--libdir=lib', 'no-shared', 'no-tests', 'no-module', '-fPIC'], output('openssl'))
    step('make', [`-j${jobs}`], output('openssl')); step('make', ['install_sw'], output('openssl'))
  }
  configure('ffmpeg', ['--enable-static', '--disable-shared', '--enable-pic', '--enable-gpl', '--enable-version3', '--disable-autodetect',
    `--pkg-config=${path.join(prefix, 'bin', platform === 'win32' ? 'pkgconf.exe' : 'pkgconf')}`,
    '--disable-programs', '--disable-doc', '--disable-debug', '--disable-avdevice', '--disable-encoders', '--enable-encoder=png,mjpeg',
    '--disable-muxers', '--enable-muxer=image2', '--enable-libdav1d', '--enable-zlib', '--pkg-config-flags=--static',
    ...({ darwin: ['--enable-videotoolbox', '--enable-audiotoolbox', '--enable-securetransport'],
      win32: ['--target-os=mingw32', '--enable-schannel', '--enable-d3d11va', '--enable-dxva2', '--enable-d3d12va'],
      linux: ['--enable-openssl', '--enable-vaapi'] }[platform])])
  step('make', ['-C', path.join(dir('lua'), 'src'), `-j${jobs}`, 'liblua.a',
    `MYCFLAGS=-O2 -fPIC ${platform === 'win32' ? '-DLUA_DL_DLL' : '-DLUA_USE_POSIX -DLUA_USE_DLOPEN'}`])
  meson('mpv', ['-Dlibmpv=true', '-Dcplayer=false', '-Dgpl=true', '-Dbuild-date=false', '-Dgl=enabled', '-Dplain-gl=enabled',
    '-Diconv=enabled', '-Dzlib=enabled', '-Dlua=lua5.2',
    ...({ darwin: ['-Dcocoa=enabled', '-Dswift-build=enabled', `-Dswift-flags=-target ${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos12.0`, '-Dgl-cocoa=enabled', '-Dcoreaudio=enabled', '-Dvideotoolbox-gl=enabled'],
      win32: ['-Dgl-win32=enabled', '-Dwasapi=enabled', '-Dd3d-hwaccel=enabled', '-Dd3d9-hwaccel=enabled'],
      linux: ['-Dalsa=enabled', '-Dx11=enabled', '-Dgl-x11=enabled', '-Dvaapi=enabled', '-Dvaapi-x11=enabled'] }[platform])], 'shared')
  return steps
}

// Static-link only our source-built libraries. Never prefer_static globally:
// fontconfig, ALSA, GL and GPU-driver libraries remain explicit system ABIs.
export function staticPlaybackDependencies(text, dependencies) {
  for (const name of dependencies) {
    const pattern = new RegExp(`dependency\\(\\s*'${name}'`, 'g')
    let count = 0
    text = text.replace(pattern, match => { count++; return match + ', static: true' })
    assert.equal(count, 1, `Pinned build recipe drift: ${name}`)
  }
  return text
}

export function playbackLinuxAssDependency(text, pkgconf) {
  const before = "libass = dependency('libass', static: true, version: '>= 0.12.2')"
  assert.equal(text.split(before).length, 2, 'Pinned libass dependency recipe drift')
  const executable = "'" + pkgconf.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"
  // Keep the complete private archive closure, but let the linker resolve the
  // host font provider dynamically. Meson's static dependency recursively
  // selects OS fontconfig/uuid archives, which need not be PIC on Ubuntu 22.04.
  // The source build supplies the private -L prefix through LDFLAGS already.
  return text.replace(before, `${before}
libass = declare_dependency(
    dependencies: libass.partial_dependency(compile_args: true, includes: true),
    link_args: run_command(find_program(${executable}),
        '--libs-only-l', '--libs-only-other', '--static', 'libass',
        check: true).stdout().strip().split())`)
}
