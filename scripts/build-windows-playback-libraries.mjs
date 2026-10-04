#!/usr/bin/env node
// Explicit local inputs only. This recipe downloads nothing and never stages a
// release runtime: the resulting DLL import closure still requires source audit.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export const WINDOWS_PLAYBACK_FFMPEG_OPTIONS = Object.freeze([
  '--target-os=mingw32', '--arch=x86_64', '--cc=clang', '--cxx=clang++',
  '--ar=llvm-ar', '--ranlib=llvm-ranlib', '--nm=llvm-nm', '--strip=llvm-strip',
  '--disable-autodetect', '--disable-static', '--enable-shared',
  '--disable-programs', '--disable-doc', '--disable-debug', '--disable-avdevice',
  '--disable-encoders', '--enable-encoder=png,mjpeg', '--disable-muxers',
  '--enable-gpl', '--enable-version3', '--enable-runtime-cpudetect',
  '--enable-dxva2', '--enable-d3d11va', '--enable-d3d12va',
  '--enable-ffnvcodec', '--enable-cuvid', '--enable-nvdec',
  '--enable-gmp', '--enable-gnutls', '--enable-iconv', '--enable-zlib',
  '--enable-bzlib', '--enable-lzma', '--enable-libdav1d', '--enable-libass',
  '--enable-libbluray', '--enable-libfontconfig', '--enable-libfreetype',
  '--enable-libfribidi', '--enable-libharfbuzz', '--enable-libgme',
  '--enable-libgsm', '--enable-libjxl', '--enable-liblc3', '--enable-libmodplug',
  '--enable-libopencore_amrnb', '--enable-libopencore_amrwb',
  '--enable-libopenjpeg', '--enable-libopus', '--enable-librtmp',
  '--enable-libssh', '--enable-libsoxr', '--enable-libspeex', '--enable-libsrt',
  '--enable-libvorbis', '--enable-libvpx', '--enable-libwebp',
  '--enable-libxml2', '--enable-libzimg', '--enable-libzvbi', '--enable-libvpl'
])
export const WINDOWS_PLAYBACK_MPV_OPTIONS = Object.freeze([
  '--wrap-mode=nodownload', '--buildtype=release', '--default-library=shared',
  '-Dlibmpv=true', '-Dcplayer=false', '-Dbuild-date=false',
  '-Dmanpage-build=disabled', '-Dvapoursynth=disabled', '-Dlibavdevice=disabled',
  '-Dcaca=disabled', '-Dcdda=enabled', '-Ddvdnav=enabled', '-Djavascript=enabled',
  '-Dlua=lua5.1', '-Dgl=enabled', '-Dgl-win32=enabled', '-Dplain-gl=enabled',
  '-Dwasapi=enabled', '-Dd3d11=enabled', '-Dshaderc=enabled', '-Dspirv-cross=enabled'
])

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This recipe requires a Windows x64 build host')
  const args = new Map()
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
  const required = name => {
    const value = args.get(name)
    if (!value) throw new Error(`Missing ${name}`)
    return path.resolve(value)
  }
  const sources = required('--sources'), prefix = required('--prefix')
  const toolchain = required('--toolchain'), msys = required('--msys')
  const python = required('--python'), work = required('--work')
  const jobs = Number(args.get('--jobs') ?? 8)
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 64) throw new Error('Invalid build parallelism')
  const env = { ...process.env, PATH: [path.join(toolchain, 'bin'), path.join(prefix, 'bin'), path.join(msys, 'usr/bin'), process.env.PATH].join(path.delimiter),
    PKG_CONFIG_PATH: path.join(prefix, 'lib/pkgconfig'), CC: 'clang', CXX: 'clang++',
    MSYS2_ARG_CONV_EXCL: '--prefix=;--extra-cflags=;--extra-ldflags=', GIT_DIR: '/dev/null' }
  const run = (command, argv, cwd) => {
    console.log(command, ...argv)
    const result = spawnSync(command, argv, { cwd, env, stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`Build command exited ${result.status}`)
  }
  const normalized = p => p.replaceAll('\\', '/')
  const ffmpegBuild = path.join(work, 'ffmpeg'), mpvBuild = path.join(work, 'mpv')
  fs.mkdirSync(ffmpegBuild, { recursive: true })
  // Match the upstream MSYS2 preparation: Windows case-insensitive lookup would
  // otherwise resolve libc++'s <version> include to FFmpeg's VERSION text file.
  const versionFile = path.join(sources, 'ffmpeg-9.0.2/VERSION')
  if (fs.existsSync(versionFile)) fs.renameSync(versionFile, path.join(sources, 'ffmpeg-9.0.2/VERSION.txt'))
  const ffmpegArgs = [normalized(path.join(sources, 'ffmpeg-9.0.2/configure')),
      `--prefix=${normalized(prefix)}`, `--extra-cflags=-I${normalized(path.join(prefix, 'include'))}`,
      `--extra-ldflags=-L${normalized(path.join(prefix, 'lib'))}`, ...WINDOWS_PLAYBACK_FFMPEG_OPTIONS]
  const configurationHash = createHash('sha256').update(JSON.stringify(ffmpegArgs)).digest('hex')
  const stamp = path.join(ffmpegBuild, 'javdex-profile.sha256')
  if (!fs.existsSync(path.join(ffmpegBuild, 'config.h')) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== configurationHash) {
    run(path.join(msys, 'usr/bin/bash.exe'), ffmpegArgs, ffmpegBuild)
    fs.writeFileSync(stamp, configurationHash)
  }
  run(path.join(msys, 'usr/bin/make.exe'), ['-r', `-j${jobs}`], ffmpegBuild)
  run(path.join(msys, 'usr/bin/make.exe'), ['-r', 'install'], ffmpegBuild)
  const mpvArgs = [mpvBuild, path.join(sources, 'mpv-0.41.0'), `--prefix=${normalized(prefix)}`,
    `-Dc_args=-I${normalized(path.join(prefix, 'include'))}`,
    `-Dc_link_args=-L${normalized(path.join(prefix, 'lib'))}`,
    ...WINDOWS_PLAYBACK_MPV_OPTIONS]
  const mpvConfigurationHash = createHash('sha256').update(JSON.stringify(mpvArgs)).digest('hex')
  const mpvStamp = path.join(mpvBuild, 'javdex-profile.sha256')
  if (!fs.existsSync(path.join(mpvBuild, 'build.ninja')) || !fs.existsSync(mpvStamp) || fs.readFileSync(mpvStamp, 'utf8') !== mpvConfigurationHash) {
    const reconfigure = fs.existsSync(path.join(mpvBuild, 'build.ninja')) ? ['--reconfigure'] : []
    run(python, ['-m', 'mesonbuild.mesonmain', 'setup', ...reconfigure, ...mpvArgs], work)
    fs.writeFileSync(mpvStamp, mpvConfigurationHash)
  }
  run(python, ['-m', 'mesonbuild.mesonmain', 'compile', '-C', mpvBuild, '-j', String(jobs)], work)
  run(python, ['-m', 'mesonbuild.mesonmain', 'install', '-C', mpvBuild], work)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
