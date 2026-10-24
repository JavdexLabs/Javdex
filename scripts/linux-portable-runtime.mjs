// Isolated Linux GPU/CPU runtimes, each with its own source and ABI contract.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { playbackFileSha256 } from './playback-runtime.mjs'

// These interfaces must match the running kernel, compositor and GPU driver.
// Audio/font/codec libraries stay private. GPU driver ABIs and their C++ runtime
// must follow the host: old libva cannot load newer vendor driver entry points.
const legacyPortableHostLibraries = new Set([
  'libc.so.6', 'libm.so.6', 'libresolv.so.2', 'libutil.so.1', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'ld-linux-x86-64.so.2',
  'libEGL.so.1', 'libGL.so.1', 'libGLdispatch.so.0', 'libGLX.so.0', 'libgbm.so.1', 'libdrm.so.2'
])
export const portableHostLibraries = new Set([...legacyPortableHostLibraries,
  'libva.so.2', 'libva-drm.so.2', 'libva-x11.so.2', 'libstdc++.so.6', 'libgcc_s.so.1'
])
export const softwareHostLibraries = new Set([...legacyPortableHostLibraries].filter(n => !/^(libEGL|libGL|libgbm|libdrm)/.test(n)))
const entries = ['playback-dmabuf-helper', 'playback-fd.node', 'libmpv.so.2']
export function copyPortableRecipe(root, destination) {
  assert.ok(!existsSync(destination), 'Recipe snapshot requires a new directory')
  const listName = '.javdex-source-files.json', saved = path.join(root, listName)
  const names = existsSync(saved) ? JSON.parse(readFileSync(saved))
    : command('git', ['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean)
  assert.ok(Array.isArray(names) && names.length > 0 && names.length <= 50000, 'Missing preferred application source list')
  assert.equal(new Set(names).size, names.length, 'Duplicate preferred source file')
  for (const name of names) {
    assert.ok(typeof name === 'string' && !/[\\:\0]/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'
      && !['node_modules', '.git', 'out', 'dist'].includes(part)), 'Unsafe preferred source file')
    assert.ok(lstatSync(path.join(root, name)).isFile() && !lstatSync(path.join(root, name)).isSymbolicLink(), 'Preferred source must be a regular file')
  }
  mkdirSync(destination, { recursive: true })
  for (const name of names) {
    mkdirSync(path.dirname(path.join(destination, name)), { recursive: true })
    cpSync(path.join(root, name), path.join(destination, name))
  }
  writeFileSync(path.join(destination, listName), JSON.stringify(names, null, 2) + '\n')
}
function command(command, args) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(r.status, 0, `${command}: ${r.stderr}`)
  return r.stdout
}
export function inspectPortableElf(file) {
  const bytes = readFileSync(file)
  assert.ok(bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 62, `Expected ELF64 x86_64: ${file}`)
  const dynamic = command('readelf', ['-dW', file])
  assert.ok(!/\((?:AUDIT|DEPAUDIT|FILTER|AUXILIARY)\)/.test(dynamic), `Forbidden ELF loader directive: ${file}`)
  const needed = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map(m => m[1])
  assert.ok(needed.every(n => /^[\w+.-]+$/.test(n)), `Unsafe DT_NEEDED: ${file}`)
  const paths = [...dynamic.matchAll(/\((?:RUNPATH|RPATH)\).*\[([^\]]*)\]/g)].flatMap(m => m[1].split(':'))
  const versionInfo = command('readelf', ['--version-info', '-W', file])
  const versions = [...versionInfo.matchAll(/Name: GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map(m => m.slice(1).map(Number))
  assert.ok(versions.every(([major, minor]) => major < 2 || major === 2 && minor <= 35), `Requires newer than glibc 2.35: ${file}`)
  const interpreter = command('readelf', ['-lW', file]).match(/Requesting program interpreter: ([^\]]+)\]/)?.[1]
  assert.ok(!interpreter || interpreter === '/lib64/ld-linux-x86-64.so.2', `Unexpected interpreter: ${file}`)
  const definitions = [...(versionInfo.split('Version definition section')[1]?.split('Version needs section')[0] ?? '').matchAll(/Name: (\S+)/g)].map(m => m[1]).sort()
  const required = {}, needs = versionInfo.split('Version needs section')[1] ?? ''
  let owner
  for (const line of needs.split('\n')) {
    const file = line.match(/File: (\S+)/)
    if (file) { owner = file[1]; required[owner] = [] }
    const name = line.match(/Name: (\S+)/)
    if (name && owner) required[owner].push(name[1])
  }
  return { needed, paths, interpreter: interpreter ?? null, definitions, required }
}
function walk(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(e => {
    assert.ok(!e.isSymbolicLink(), `Unexpected runtime symlink: ${prefix}${e.name}`)
    return e.isDirectory() ? walk(path.join(directory, e.name), `${prefix}${e.name}/`) : [prefix + e.name]
  }).sort()
}
export function validatePortableRuntime(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, 'portable-runtime.json')))
  assert.equal(manifest.schemaVersion, 1)
  assert.ok(['linux-x64-dmabuf-pulse', 'linux-x64-software-pulse'].includes(manifest.profile))
  const software = manifest.profile === 'linux-x64-software-pulse'
  assert.ok(manifest.driverAbi === undefined || (!software && manifest.driverAbi === 'host-vaapi-cxx-v1'), 'Unknown driver ABI policy')
  const hostLibraries = software ? softwareHostLibraries : manifest.driverAbi ? portableHostLibraries : legacyPortableHostLibraries
  const entries = [software ? 'playback-software-helper' : 'playback-dmabuf-helper', 'playback-fd.node', 'libmpv.so.2']
  assert.deepEqual(manifest.hostLibraries, [...hostLibraries].sort())
  assert.deepEqual(walk(directory).filter(f => f !== 'portable-runtime.json'), Object.keys(manifest.files).sort(), 'Unlisted or missing portable files')
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert.equal(playbackFileSha256(path.join(directory, file)), digest, `Portable hash mismatch: ${file}`)
  }
  for (const file of entries) assert.ok(manifest.elf[file], `Missing portable entry: ${file}`)
  assert.ok(!manifest.elf[entries[0]].needed.some(n => ['libOpenGL.so.0', 'libGL.so.1', 'libGLX.so.0'].includes(n)), 'DMA-BUF helper must use EGL GL entry points')
  assert.ok(!manifest.elf[entries[2]].needed.some(n => /^(libX|libGLX|libasound)/.test(n)), 'Dedicated libmpv must not import native X11/GLX/ALSA output')
  const accounted = new Set(manifest.components.flatMap(c => {
    assert.ok(manifest.files[c.licenseFile], `Missing license: ${c.name}`)
    assert.ok(c.sourcePackage || c.sourceLock, `Missing source provenance: ${c.name}`)
    return c.binaries
  }))
  for (const file of Object.keys(manifest.elf)) {
    if (manifest.driverAbi) assert.ok(!hostLibraries.has(path.basename(file)), `Host driver ABI must not be shadowed: ${file}`)
    assert.ok(accounted.has(file), `Unattributed ELF: ${file}`)
    assert.ok(entries.includes(file) || /^lib\/[\w+.-]+\.so(?:\.\d+)*$/.test(file), `Unsafe ELF destination: ${file}`)
    assert.ok(!/(?:nvidia|_dri|vulkan|libEGL_|libGLX_)/i.test(file), `Vendor driver must stay on host: ${file}`)
    const elf = inspectPortableElf(path.join(directory, file))
    if (software) assert.ok(!elf.needed.some(n => /^(libEGL|libGL|libgbm|libdrm|libva|libvdpau|libvulkan)/.test(n)), `GPU dependency in CPU runtime: ${file}`)
    assert.deepEqual(elf, manifest.elf[file], `ELF metadata mismatch: ${file}`)
    assert.deepEqual(elf.paths, file.startsWith('lib/') ? ['$ORIGIN'] : ['$ORIGIN', '$ORIGIN/lib'], `Non-private library search: ${file}`)
    for (const dependency of elf.needed) {
      if (hostLibraries.has(dependency)) continue
      const resolved = manifest.elf['lib/' + dependency] ?? (!file.startsWith('lib/') ? manifest.elf[dependency] : undefined)
      assert.ok(resolved, `Unresolved portable dependency: ${file} -> ${dependency}`)
      for (const version of elf.required[dependency] ?? []) assert.ok(resolved.definitions.includes(version), `Missing ABI version: ${file} -> ${dependency} (${version})`)
    }
  }
  // Detect accidentally added ELF files even if the inventory hash was updated.
  for (const file of Object.keys(manifest.files)) {
    if (readFileSync(path.join(directory, file)).subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) assert.ok(manifest.elf[file], `Uninspected ELF: ${file}`)
  }
  return manifest
}

export async function buildPortablePlaybackRuntime(input) {
  const { root, sourceRoot, buildRoot, prefix, include, cache, sources, lock, fingerprint, toolchain, plan, patches, destination, run } = input
  const software = input.software === true
  const hostLibraries = software ? softwareHostLibraries : portableHostLibraries
  const entries = [software ? 'playback-software-helper' : 'playback-dmabuf-helper', 'playback-fd.node', 'libmpv.so.2']
  const native = path.join(root, 'apps/desktop/src/main/player/native')
  const staged = path.join(buildRoot, 'portable-runtime')
  mkdirSync(path.join(staged, 'lib'), { recursive: true }); mkdirSync(path.join(staged, 'licenses'))
  const nativePlan = [
    ['c++', ['-std=c++17', '-O2', '-Wall', '-Wextra', `-I${prefix}/include`, ...(software ? [] : ['-I/usr/include/libdrm']), path.join(native, software ? 'linuxSoftwarePlayback.cpp' : 'linuxDmaBufPlayback.cpp'), `-L${prefix}/lib`, '-lmpv', ...(software ? [] : ['-lEGL', '-lgbm', '-ldrm']), '-o', path.join(staged, entries[0])]],
    ['c++', ['-std=c++17', '-O2', '-shared', '-fPIC', `-I${include}`, path.join(native, 'linuxFdBridge.cpp'), '-o', path.join(staged, entries[1])]],
    ['c++', ['-std=c++17', '-O2', '-UNDEBUG', path.join(native, 'linuxDmaBuf.test.cpp'), '-o', path.join(buildRoot, 'linux-dmabuf-test')]],
    [path.join(buildRoot, 'linux-dmabuf-test'), []],
    ['c++', ['-std=c++17', '-O2', '-UNDEBUG', path.join(native, 'linuxFrameTiming.test.cpp'), '-o', path.join(buildRoot, 'linux-frame-timing-test')]],
    [path.join(buildRoot, 'linux-frame-timing-test'), []]
  ]
  for (const [cmd, args] of nativePlan) run(cmd, args)
  cpSync(realpathSync(path.join(prefix, 'lib/libmpv.so.2')), path.join(staged, entries[2]))
  const manifest = { schemaVersion: 1, ...(!software ? { driverAbi: 'host-vaapi-cxx-v1' } : {}), profile: software ? 'linux-x64-software-pulse' : 'linux-x64-dmabuf-pulse', baseline: 'Ubuntu 22.04 / glibc 2.35', electronVersion: lock.sdk.electronVersion,
    hostLibraries: [...hostLibraries].sort(), files: {}, elf: {}, components: [] }
  mkdirSync(path.join(staged, 'licenses/common'))
  for (const name of readdirSync('/usr/share/common-licenses')) writeFileSync(path.join(staged, 'licenses/common', name), readFileSync(path.join('/usr/share/common-licenses', name)))
  const sourcePackages = new Map()
  assert.ok(readFileSync('/etc/os-release', 'utf8').includes('VERSION_ID="22.04"'), 'Build this portable profile inside Ubuntu 22.04')
  function distributionComponent(original, target) {
    let owner
    const aliases = [original, realpathSync(original), original.startsWith('/lib/') ? '/usr' + original : original.replace(/^\/usr\/lib\//, '/lib/')]
    for (const candidate of new Set(aliases)) {
      try { owner = run('dpkg-query', ['-S', candidate], root, true).split(': ')[0]; break } catch { /* merged-/usr alias */ }
    }
    assert.ok(owner, `No distribution source owner for ${original}`)
    const [binary, version, sourcePackage, sourceVersion] = run('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}', owner], root, true).split('\t')
    const name = binary.split(':')[0], licenseFile = `licenses/${name}.txt`
    writeFileSync(path.join(staged, licenseFile), readFileSync(`/usr/share/doc/${name}/copyright`))
    manifest.components.push({ name: binary, version, sourcePackage, sourceVersion, licenseFile, binaries: [target], originalSha256: playbackFileSha256(original) })
    sourcePackages.set(sourcePackage, sourceVersion)
  }
  const ldconfig = run('/sbin/ldconfig', ['-p'], root, true)
  function resolveLibrary(name) {
    const match = ldconfig.split('\n').find(line => line.trim().startsWith(name + ' ') && line.includes('x86-64'))
    if (match) return match.split('=>')[1].trim()
    const pulse = path.join('/usr/lib/x86_64-linux-gnu/pulseaudio', name)
    assert.ok(existsSync(pulse) && /^libpulsecommon-[\w.-]+\.so$/.test(name), `Missing build-baseline library: ${name}`)
    return pulse
  }
  const pending = [...entries], done = new Set()
  while (pending.length) {
    const file = pending.shift(); if (done.has(file)) continue; done.add(file)
    const full = path.join(staged, file)
    for (const needed of inspectPortableElf(full).needed) {
      if (hostLibraries.has(needed) || entries.includes(needed)) continue
      const target = 'lib/' + needed
      if (!existsSync(path.join(staged, target))) {
        const original = resolveLibrary(needed)
        cpSync(realpathSync(original), path.join(staged, target)); distributionComponent(original, target)
      }
      pending.push(target)
    }
    run('patchelf', ['--set-rpath', file.startsWith('lib/') ? '$ORIGIN' : '$ORIGIN:$ORIGIN/lib', full])
    manifest.elf[file] = inspectPortableElf(full)
  }
  // libpulse's matching common library is a DT_NEEDED dependency and joins the
  // closure above. No ALSA plugin directory or host audio daemon is packaged.
  cpSync(path.join(cache, 'Node-v24.22.0-LICENSE.txt'), path.join(staged, 'licenses/node-headers.txt'))
  const notices = sources.flatMap(s => [`\n=== ${s.id} ${s.version} ${s.url} (${s.license}) ===\n`, ...s.licenseFiles.map(f => readFileSync(path.join(sourceRoot, s.id, f), 'utf8'))])
  writeFileSync(path.join(staged, 'licenses/libmpv.txt'), notices.join('\n'))
  cpSync(path.join(root, 'LICENSE'), path.join(staged, 'licenses/javdex.txt'))
  manifest.components.push({ name: 'libmpv-private', version: '0.41.0', sourceLock: 'build/playback-sources.json', licenseFile: 'licenses/libmpv.txt', binaries: [entries[2]] },
    { name: 'javdex-native', sourceLock: 'build.json', licenseFile: 'licenses/javdex.txt', binaries: entries.slice(0, 2) })
  mkdirSync(path.join(staged, 'fonts'))
  cpSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', path.join(staged, 'fonts/DejaVuSans.ttf'))
  distributionComponent('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'fonts/DejaVuSans.ttf')
  writeFileSync(path.join(staged, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig><dir prefix="relative">fonts</dir><dir>/usr/share/fonts</dir><dir>/usr/local/share/fonts</dir><dir prefix="xdg">fonts</dir><cachedir prefix="xdg">fontconfig</cachedir></fontconfig>\n`)
  const receipt = { profile: manifest.profile, fingerprint, toolchain, sdk: lock.sdk, sources, patches, commands: [...plan, ...nativePlan], sourcePackages: Object.fromEntries(sourcePackages) }
  writeFileSync(path.join(staged, 'build.json'), JSON.stringify(receipt, null, 2) + '\n')
  const delivery = path.join(buildRoot, 'source-delivery'); mkdirSync(delivery, { recursive: true })
  cpSync(include, path.join(delivery, 'electron-sdk/include/node'), { recursive: true })
  cpSync(path.join(cache, 'Node-v24.22.0-LICENSE.txt'), path.join(delivery, 'Node-LICENSE'))
  for (const source of sources) cpSync(path.join(cache, source.filename), path.join(delivery, source.filename))
  for (const [name, version] of sourcePackages) run('apt-get', ['source', '--download-only', `${name}=${version}`], delivery)
  rmSync(path.join(delivery, 'runtime'), { recursive: true, force: true })
  rmSync(path.join(delivery, 'recipe'), { recursive: true, force: true })
  cpSync(staged, path.join(delivery, 'runtime'), { recursive: true })
  copyPortableRecipe(root, path.join(delivery, 'recipe'))
  const decode = path.join(buildRoot, 'runtime-decode-test')
  run('c++', ['-std=c++17', `-I${prefix}/include`, path.join(native, 'runtimeDecode.test.cpp'), '-ldl', '-o', decode])
  run(decode, [path.join(staged, 'libmpv.so.2'), path.join(buildRoot, 'smoke.wav')])
  const archive = path.join(buildRoot, `Javdex-Linux-Portable-Sources-${fingerprint.slice(0, 12)}-${Date.now()}.tar.gz`)
  run('tar', ['-czf', archive, '-C', delivery, '.'])
  // Source delivery is adjacent to the runtime, never inflated into AppImage.
  manifest.sourceBundle = { filename: path.basename(archive), sha256: playbackFileSha256(archive) }
  for (const file of walk(staged)) manifest.files[file] = playbackFileSha256(path.join(staged, file))
  writeFileSync(path.join(staged, 'portable-runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
  validatePortableRuntime(staged)
  mkdirSync(path.dirname(destination), { recursive: true })
  if (existsSync(destination)) renameSync(destination, destination + '.previous-' + Date.now())
  renameSync(staged, destination)
  cpSync(archive, path.join(path.dirname(destination), path.basename(archive)))
  // Compile the final-installer PCM fixture against the exact pinned headers,
  // without shipping SDK headers inside either helper's runtime directory.
  cpSync(path.join(prefix, 'include/mpv'), path.join(path.dirname(destination), 'smoke-headers/mpv'), { recursive: true })
  console.log(`Portable runtime ready: ${destination}`)
}
