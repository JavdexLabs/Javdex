// Release source build plan. OS compiler/SDK/display/audio/driver ABIs are
// prerequisites; no package-manager codec or Homebrew libmpv enters this plan.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { playbackNativeBuild } from './playback-native-build.mjs'

export function verifyPlaybackSource(file, source) {
  assert.equal(statSync(file).size, source.bytes, `Source size mismatch: ${source.id}`)
  assert.equal(playbackFileSha256(file), source.sha256, `Source digest mismatch: ${source.id}`)
}

export function playbackWindowsExportNames(output) {
  // GNU objdump's newer name table adds base and hexadecimal hint columns.
  // Do not mistake import names or export-address/forwarder rows for exports.
  const table = output.replaceAll('\r\n', '\n').split(/^\[Ordinal\/Name Pointer\] Table(?: -- Ordinal Base \d+)?[ \t]*$/m)[1]?.split(/\n[ \t]*\n/, 1)[0] ?? ''
  return [...table.matchAll(/^[ \t]*\[[ \t]*\d+\][ \t]+(?:\+base\[[ \t]*\d+\][ \t]+[a-fA-F0-9]+[ \t]+)?(mpv_[a-zA-Z0-9_]+)[ \t]*$/gm)].map(match => match[1])
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

export function playbackWindowsSourceEnvironment(prefix, runtimeSymbols) {
  // Meson's built-in dependency lookups also inspect GCC's library search
  // directories. -L in LDFLAGS alone does not keep them out of MSYS2 codecs.
  const fenvDefault = /\b[RDS]\s+__mingw_fe_dfl_env(?:\r?\n|$)/.test(runtimeSymbols)
  return { libraryPath: path.join(prefix, 'lib'), fenvDefault,
    linkArgs: ['-static', '-static-libgcc', '-static-libstdc++',
      // Recent MinGW CRTs put this definition in CRT_fp10.o. DLL startup does
      // not pull it in before fesetenv; retain the real CRT definition.
      ...(fenvDefault ? ['-Wl,--undefined=__mingw_fe_dfl_env'] : [])] }
}

export function stageWindowsStaticZlib(prefix) {
  const source = path.join(prefix, 'lib/libzs.a'), destination = path.join(prefix, 'lib/libz.a')
  assert.ok(existsSync(source), 'Missing pinned Windows static zlib archive')
  const sha256 = playbackFileSha256(source)
  if (existsSync(destination)) assert.equal(playbackFileSha256(destination), sha256, 'Refusing to replace a different Windows zlib archive')
  else copyFileSync(source, destination)
  // zlib 1.3.2 gives static Windows archives an s suffix, but its .pc uses -lz.
  return { source: 'lib/libzs.a', destination: 'lib/libz.a', sha256 }
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

export function playbackSourcePlan({ platform, arch, source, build, prefix, tools, jobs, linuxProfile = platform === 'linux' ? 'dmabuf' : undefined }) {
  assert.ok(['darwin', 'linux', 'win32'].includes(platform), 'Unsupported playback host')
  assert.ok(['x64', 'arm64'].includes(arch) && (platform !== 'win32' || arch === 'x64'), 'Unsupported playback architecture')
  assert.ok(linuxProfile === undefined || ['dmabuf', 'software'].includes(linuxProfile), 'Unsupported Linux playback profile')
  assert.ok(linuxProfile === undefined || platform === 'linux', 'DMA-BUF profile requires Linux')
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
  // Header-only API shim: the NVIDIA driver stays on the host. No CUDA toolkit.
  if (platform === 'linux' && linuxProfile === 'dmabuf') {
    step('make', [`PREFIX=${prefix}`, 'install'], dir('nv_codec_headers'))
  }
  configure('ffmpeg', ['--enable-static', '--disable-shared', '--enable-pic', '--enable-gpl', '--enable-version3', '--disable-autodetect',
    `--pkg-config=${path.join(prefix, 'bin', platform === 'win32' ? 'pkgconf.exe' : 'pkgconf')}`,
    '--disable-programs', '--disable-doc', '--disable-debug', '--disable-avdevice', '--disable-encoders', '--enable-encoder=png,mjpeg',
    '--disable-muxers', '--enable-muxer=image2', '--enable-libdav1d', '--enable-zlib', '--pkg-config-flags=--static',
    ...({ darwin: ['--enable-videotoolbox', '--enable-audiotoolbox', '--enable-securetransport'],
      win32: ['--target-os=mingw32', '--enable-schannel', '--enable-d3d11va', '--enable-dxva2', '--enable-d3d12va'],
      linux: ['--enable-openssl', linuxProfile === 'software' ? '--disable-vaapi' : '--enable-vaapi', ...(linuxProfile === 'dmabuf' ? ['--enable-ffnvcodec', '--enable-nvdec', '--enable-cuda', '--disable-nvenc'] : ['--disable-ffnvcodec', '--disable-nvdec', '--disable-cuda']), ...(linuxProfile === 'software' ? ['--disable-hwaccels'] : [])] }[platform])])
  step('make', ['-C', path.join(dir('lua'), 'src'), `-j${jobs}`, 'liblua.a',
    `MYCFLAGS=-O2 -fPIC ${platform === 'win32' ? '-DLUA_DL_DLL' : '-DLUA_USE_POSIX -DLUA_USE_DLOPEN'}`])
  // mpv 0.41 requires gl-win32 to enable egl-angle; the application uses only
  // its external ANGLE render context, never the former WGL producer.
  meson('mpv', ['-Dlibmpv=true', '-Dcplayer=false', '-Dgpl=true', '-Dbuild-date=false', `-Dgl=${linuxProfile === 'software' ? 'disabled' : 'enabled'}`, `-Dplain-gl=${linuxProfile === 'software' ? 'disabled' : 'enabled'}`,
    '-Diconv=enabled', '-Dzlib=enabled', '-Dlua=lua5.2',
    ...({ darwin: ['-Dcocoa=enabled', '-Dswift-build=enabled', `-Dswift-flags=-target ${arch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos12.0`, '-Dgl-cocoa=enabled', '-Dcoreaudio=enabled', '-Dvideotoolbox-gl=enabled'],
      win32: ['-Dwin32-threads=enabled', '-Dgl-win32=enabled', '-Dwasapi=enabled', '-Dd3d-hwaccel=enabled', '-Dd3d9-hwaccel=enabled', '-Degl-angle=enabled', '-Degl-angle-lib=disabled', '-Degl-angle-win32=disabled'],
      linux: linuxProfile === 'software'
        ? ['-Dcuda-hwaccel=disabled', '-Dcuda-interop=disabled', '-Dpulse=enabled', '-Dalsa=disabled', '-Dx11=disabled', '-Dgl-x11=disabled', '-Dvaapi=disabled', '-Dvaapi-x11=disabled', '-Dvaapi-drm=disabled']
        : ['-Dcuda-hwaccel=enabled', '-Dcuda-interop=enabled', '-Dpulse=enabled', '-Dalsa=disabled', '-Dx11=disabled', '-Dgl-x11=disabled', '-Dvaapi=enabled', '-Dvaapi-x11=disabled', '-Dvaapi-drm=enabled'] }[platform])], 'shared')
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

// libmpv's VAAPI DRM display creation needs libva-drm and a render fd, not
// mpv's KMS window output, VT switching, EDID parser or libdisplay-info.
export function playbackLinuxVaapiRenderDependency(text) {
  const before = "get_option('vaapi-drm').require(libva.found() and features['drm'])"
  assert.equal(text.split(before).length, 2, 'Pinned VAAPI DRM recipe drift')
  return text.replace(before, "get_option('vaapi-drm').require(libva.found())")
}

// Backport mpv f74adc4243bd9e1a8ee96d187c939e6232510650 (#17217).
// Render API clients have no native swap_buffers callback to retire this queue.
export function playbackMpvRenderFenceFix(source) {
  const before = '    if (gl->FenceSync) {\n        GLsync fence = gl->FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);'
  const after = before.replace('if (gl->FenceSync)', 'if (gl->FenceSync && p->params.swap_buffers)')
  assert.equal(source.split(before).length, 2, 'Pinned mpv render fence source drift')
  return source.replace(before, after)
}

/** Opt-in copy-back wall time, batched at source; never label this GPU-only time. */
export function playbackMpvHwdownloadTiming(text) {
  const field = '    int hwdec_fail_count;'
  const download = '        struct mp_image *sw = mp_image_hw_download(res, ctx->hwdec_swpool);'
  assert.ok(!text.includes('javdex_download_count'), 'Pinned mpv decoder timing patch already applied')
  assert.equal(text.split(field).length, 2, 'Pinned mpv decoder fields drifted')
  assert.equal(text.split(download).length, 2, 'Pinned mpv copy-back call drifted')
  return text.replace('#include <float.h>', '#include <float.h>\n#include "osdep/timer.h"\n#include <libavutil/hwcontext_d3d11va.h>\n#include <dxgi.h>')
    .replace(field, field + '\n    uint64_t javdex_download_count;\n    int64_t javdex_download_total, javdex_download_max;')
    .replace(download, `        const char *diagnostics = getenv("JAVDEX_PLAYBACK_DIAGNOSTICS");
        const bool measure = diagnostics && strcmp(diagnostics, "1") == 0;
        if (measure && !ctx->javdex_download_count) {
            const AVHWFramesContext *frames = (const AVHWFramesContext *)res->hwctx->data;
            if (frames && frames->device_ctx && frames->device_ctx->type == AV_HWDEVICE_TYPE_D3D11VA) {
                const AVD3D11VADeviceContext *hardware = (const AVD3D11VADeviceContext *)frames->device_ctx->hwctx;
                IDXGIDevice *dxgi = NULL; IDXGIAdapter *adapter = NULL; DXGI_ADAPTER_DESC description;
                if (hardware && hardware->device
                    && SUCCEEDED(ID3D11Device_QueryInterface(hardware->device, &IID_IDXGIDevice, (void **)&dxgi))
                    && SUCCEEDED(IDXGIDevice_GetAdapter(dxgi, &adapter)) && SUCCEEDED(IDXGIAdapter_GetDesc(adapter, &description)))
                    MP_INFO(vd, "javdex-decoder-device %lu %lu %lu %ld\\n", (unsigned long)description.VendorId,
                        (unsigned long)description.DeviceId, (unsigned long)description.AdapterLuid.LowPart, (long)description.AdapterLuid.HighPart);
                if (adapter) IDXGIAdapter_Release(adapter);
                if (dxgi) IDXGIDevice_Release(dxgi);
            }
        }
        const int64_t started = measure ? mp_time_ns() : 0;
${download}
        if (measure && sw) {
            const int64_t elapsed = mp_time_ns() - started;
            ctx->javdex_download_total += elapsed;
            ctx->javdex_download_max = MPMAX(ctx->javdex_download_max, elapsed);
            if (++ctx->javdex_download_count == 1 || ctx->javdex_download_count % 30 == 0)
                MP_INFO(vd, "javdex-hwdownload %llu %lld %lld\\n",
                    (unsigned long long)ctx->javdex_download_count,
                    (long long)(ctx->javdex_download_total / 1000),
                    (long long)(ctx->javdex_download_max / 1000));
        }`)
}

/** Recent ANGLE advertises EXT_device_query on the client, not the display. */
export function playbackMpvAngleDeviceQueryFix(text) {
  const query = '    const char *exts = eglQueryString(egl_display, EGL_EXTENSIONS);'
  const guard = '        !gl_check_extension(exts, "EGL_EXT_device_query") ||'
  assert.equal(text.split(query).length, 2, 'Pinned ANGLE hwdec query drifted')
  assert.equal(text.split(guard).length, 2, 'Pinned ANGLE hwdec capability guard drifted')
  return text.replace(query, query + '\n    const char *client_exts = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);')
    .replace(guard, '        !(gl_check_extension(exts, "EGL_EXT_device_query") ||\n          (client_exts && gl_check_extension(client_exts, "EGL_EXT_device_query"))) ||')
}
