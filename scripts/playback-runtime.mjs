// Packaging inputs only. This verifies an inventory, not license compliance or
// playback acceptance; a build cannot turn development Homebrew files into a release.
import assert from 'node:assert/strict'
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { electronBuilderArchName } from './packaging-runtime.mjs'

function digest(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), descriptor = openSync(file, 'r')
  try {
    let count
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
    return hash.digest('hex')
  } finally { closeSync(descriptor) }
}
const linuxPlaybackHelper = 'playback-helper'
const binary = file => file === linuxPlaybackHelper || /\.(node|dylib|dll)$|\.so(?:\.\d+)*$/.test(file)
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096
function relativeFile(value) {
  assert.ok(text(value) && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..'), 'invalid playback inventory path')
  return value
}
function inside(directory, file) {
  const relative = path.relative(directory, file)
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
function filesIn(directory, prefix = '') {
  const files = []
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!item.isSymbolicLink(), 'playback runtimes must not contain symlinks')
    const name = prefix + item.name
    if (item.isDirectory()) files.push(...filesIn(path.join(directory, item.name), name + '/'))
    else { assert.ok(item.isFile(), 'playback runtime contains a non-file entry'); files.push(name) }
  }
  return files.sort()
}
function tool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' } })
  if (result.error) throw result.error
  assert.equal(result.status, 0, command + ' could not inspect playback binary: ' + result.stderr)
  return result.stdout
}

export function inspectMacPlaybackBinary(file, { directory, archName, binaryFiles }) {
  assert.equal(process.platform, 'darwin', 'Mach-O verification requires a macOS build host')
  const arch = { arm64: 'arm64', x64: 'x86_64' }[archName]
  assert.ok(arch, 'unsupported playback runtime architecture')
  assert.ok(tool('lipo', ['-archs', file]).trim().split(/\s+/).includes(arch), 'playback binary architecture does not match its package')
  const local = locator => {
    assert.ok(locator === '@loader_path' || locator.startsWith('@loader_path/'), 'playback runtime has a non-local dependency or rpath: ' + locator)
    const resolved = path.resolve(path.dirname(file), locator === '@loader_path' ? '' : locator.slice('@loader_path/'.length))
    assert.ok(inside(directory, resolved), 'playback dependency escapes its runtime')
    return resolved
  }
  const commands = tool('otool', ['-l', file])
  const ids = new Set([...commands.matchAll(/cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/g)].map(match => match[1]))
  for (const id of ids) assert.ok(id === '@rpath/' + path.basename(file) || id === '@loader_path/' + path.basename(file),
    'playback library has a non-canonical install name: ' + id)
  for (const line of tool('otool', ['-L', file]).split('\n').filter(line => /^\s+/.test(line))) {
    const dependency = line.trim().replace(/ \(compatibility version.*$/, '')
    if (ids.has(dependency)) continue // LC_ID_DYLIB names this image, not a dependency.
    const normalized = path.posix.normalize(dependency)
    if (normalized.startsWith('/System/Library/') || normalized.startsWith('/usr/lib/')) continue
    const resolved = local(dependency)
    assert.ok(binaryFiles.has(resolved), 'playback dependency is absent from the inventory: ' + dependency)
  }
  for (const match of commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)) {
    assert.ok(inside(directory, local(match[1])), 'playback rpath escapes its runtime')
  }
}

// Explicit OS ABI/display/font prerequisites, not arbitrary libraries found in
// /usr/lib. Codecs, libmpv and their non-system dependencies must be inventoried.
const linuxSystemLibraries = new Set([
  'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
  'libgcc_s.so.1', 'libstdc++.so.6', 'libX11.so.6', 'libXext.so.6', 'libxcb.so.1',
  'libXrender.so.1', 'libXft.so.2', 'libfontconfig.so.1', 'libfreetype.so.6',
  'libGL.so.1', 'libGLX.so.0', 'libOpenGL.so.0', 'libGLdispatch.so.0', 'libEGL.so.1'
])

function inspectLinuxHelperHeader(file, data, archName) {
  assert.ok(lstatSync(file).mode & 0o111, 'Linux playback helper must be executable')
  assert.ok(data.readBigUInt64LE(24) !== 0n, 'Linux playback helper has no ELF entry point')
  const offset = data.readBigUInt64LE(32), size = data.readUInt16LE(54), count = data.readUInt16LE(56)
  assert.ok(offset >= 64n && size === 56 && count > 0 && offset + BigInt(size * count) <= BigInt(data.length),
    'invalid Linux playback helper program headers')
  const interpreters = []
  for (let index = 0; index < count; index++) {
    const header = Number(offset) + index * size
    if (data.readUInt32LE(header) !== 3) continue // PT_INTERP
    const start = data.readBigUInt64LE(header + 8), length = data.readBigUInt64LE(header + 32)
    assert.ok(length > 1n && start + length <= BigInt(data.length), 'invalid Linux playback helper interpreter')
    const value = data.subarray(Number(start), Number(start + length))
    assert.ok(value.at(-1) === 0 && !value.subarray(0, -1).includes(0), 'invalid Linux playback helper interpreter')
    interpreters.push(value.subarray(0, -1).toString('utf8'))
  }
  const allowed = archName === 'x64'
    ? ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2']
    : ['/lib/ld-linux-aarch64.so.1', '/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1']
  assert.ok(interpreters.length === 1 && allowed.includes(interpreters[0]),
    'Linux playback helper must use the target system glibc interpreter')
}

/** readDynamic is a private inspection seam for parser tests. No ldd/dlopen is
 * used on runtime inputs; GNU readelf can inspect ELF without executing it. */
export function inspectLinuxPlaybackBinary(file, { directory, archName, binaryFiles }, readDynamic = file => tool('readelf', ['-dW', file])) {
  const data = readFileSync(file)
  assert.ok(data.length >= 64 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'playback binary is not ELF')
  assert.ok(data[4] === 2 && data[5] === 1 && data[6] === 1 && data.readUInt32LE(20) === 1,
    'playback runtime requires 64-bit little-endian ELF')
  const helper = file === path.join(directory, linuxPlaybackHelper)
  const type = data.readUInt16LE(16)
  assert.ok(helper ? type === 2 || type === 3 : type === 3,
    helper ? 'Linux playback helper must be an ELF executable or PIE' : 'playback binary must be an ELF shared object')
  const machine = { x64: 62, arm64: 183 }[archName]
  assert.ok(machine && data.readUInt16LE(18) === machine, 'playback binary architecture does not match its package')
  if (helper) inspectLinuxHelperHeader(file, data, archName)
  const dynamic = readDynamic(file)
  assert.match(dynamic, /\(NULL\)/, 'missing ELF dynamic section')
  assert.ok(!/\((AUDIT|DEPAUDIT|FILTER|AUXILIARY)\)/.test(dynamic), 'unsupported ELF dynamic dependency indirection')
  const tags = [...dynamic.matchAll(/\((NEEDED|SONAME|RPATH|RUNPATH)\)[^\n\r]*?\[([^\]\r\n]*)\]/g)]
  const paths = new Map()
  const needed = []
  const name = value => {
    assert.ok(value && !value.includes('/') && !value.includes('\\') && !value.includes('$') && !/[\s\0:]/.test(value)
      && value !== '.' && value !== '..', 'non-canonical ELF dependency name: ' + value)
    return value
  }
  for (const [, kind, value] of tags) {
    if (kind === 'NEEDED') needed.push(name(value))
    else if (kind === 'SONAME') assert.equal(name(value), path.basename(file), 'non-canonical ELF SONAME')
    else {
      assert.ok(!paths.has(kind), 'duplicate ELF search path entry')
      paths.set(kind, value.split(':').map(locator => {
        const origin = locator.match(/^\$(?:ORIGIN|\{ORIGIN\})(\/[^$\\\0]*)?$/)
        assert.ok(origin, 'playback runtime has a non-local ELF search path: ' + locator)
        const resolved = path.resolve(path.dirname(file), '.' + (origin[1] ?? ''))
        assert.ok(inside(directory, resolved), 'ELF search path escapes its runtime')
        return resolved
      }))
    }
  }
  // Don't accept truncated/unknown readelf forms by silently dropping a tag.
  assert.equal(tags.length, [...dynamic.matchAll(/\((?:NEEDED|SONAME|RPATH|RUNPATH)\)/g)].length, 'unrecognized ELF dynamic entry')
  const loader = archName === 'x64' ? 'ld-linux-x86-64.so.2' : 'ld-linux-aarch64.so.1'
  const search = paths.get('RUNPATH') ?? paths.get('RPATH') ?? []
  for (const dependency of needed) {
    if (linuxSystemLibraries.has(dependency) || dependency === loader) continue
    assert.ok(search.some(directory => binaryFiles.has(path.join(directory, dependency))),
      'ELF dependency is absent from its runtime-local search paths/inventory: ' + dependency)
  }
}

// Parse PE imports directly, including the Electron delay-load dependency. This
// does not execute an unreviewed DLL or depend on a developer's dumpbin PATH.
export function inspectWindowsPlaybackBinary(file, { directory, archName, binaryFiles }) {
  const data = readFileSync(file)
  const range = (offset, length) => {
    assert.ok(Number.isSafeInteger(offset) && offset >= 0 && length >= 0 && offset + length <= data.length, 'invalid PE file range')
    return offset
  }
  range(0, 64)
  assert.equal(data.readUInt16LE(0), 0x5a4d, 'playback binary is not PE')
  const pe = range(data.readUInt32LE(60), 24)
  assert.equal(data.readUInt32LE(pe), 0x4550, 'playback binary is not PE')
  assert.equal(data.readUInt16LE(pe + 4), { x64: 0x8664, arm64: 0xaa64 }[archName], 'playback binary architecture does not match its package')
  assert.ok(data.readUInt16LE(pe + 22) & 0x2000, 'playback PE must be a DLL')
  const count = data.readUInt16LE(pe + 6), size = data.readUInt16LE(pe + 20), optional = range(pe + 24, size)
  assert.ok(size >= 112 && data.readUInt16LE(optional) === 0x20b, 'playback runtime requires PE32+')
  const directories = data.readUInt32LE(optional + 108)
  assert.ok(directories <= 16 && 112 + directories * 8 <= size, 'invalid PE data directories')
  assert.ok(count > 0 && count <= 96, 'invalid PE section count')
  const sections = []
  range(optional + size, count * 40)
  for (let index = 0; index < count; index++) {
    const section = optional + size + index * 40
    const rawSize = data.readUInt32LE(section + 16), raw = data.readUInt32LE(section + 20)
    if (rawSize) range(raw, rawSize)
    sections.push({ address: data.readUInt32LE(section + 12), raw, rawSize })
  }
  const rva = (address, length) => {
    assert.ok(address > 0, 'invalid PE RVA')
    const found = sections.filter(section => address >= section.address && address + length <= section.address + section.rawSize)
    assert.equal(found.length, 1, 'PE RVA is not backed by one file section')
    return range(found[0].raw + address - found[0].address, length)
  }
  const name = address => {
    const offset = rva(address, 1), end = data.indexOf(0, offset)
    assert.ok(end > offset && end - offset <= 255, 'invalid PE dependency name')
    rva(address, end - offset + 1)
    const value = data.subarray(offset, end).toString('ascii').toLowerCase()
    assert.match(value, /^[a-z0-9_.+-]+\.(dll|exe)$/, 'non-canonical PE dependency name')
    assert.ok(!data.subarray(offset, end).some(byte => byte > 127), 'non-ASCII PE dependency name')
    return value
  }
  const imports = (index, stride, delayed) => {
    if (index >= directories) return []
    const address = data.readUInt32LE(optional + 112 + index * 8), length = data.readUInt32LE(optional + 116 + index * 8)
    if (!address && !length) return []
    assert.ok(length >= stride, 'invalid PE import directory')
    const start = rva(address, length), result = []
    for (let offset = start; offset + stride <= start + length; offset += stride) {
      if (data.subarray(offset, offset + stride).every(byte => byte === 0)) return result
      if (delayed) assert.equal(data.readUInt32LE(offset), 1, 'PE delay imports must use RVAs')
      result.push(name(data.readUInt32LE(offset + (delayed ? 4 : 12))))
    }
    throw new Error('unterminated PE import directory')
  }
  const dependencies = imports(1, 20, false), delayedDependencies = imports(13, 32, true)
  const entry = path.resolve(file) === path.join(directory, 'playback.node')
  if (entry) {
    assert.ok(!dependencies.includes('node.exe') && delayedDependencies.includes('node.exe'), 'Windows addon must delay-load the Electron host')
    assert.ok(dependencies.some(value => /^(lib)?mpv(?:-\d+)?\.dll$/.test(value)), 'Windows addon must import libmpv')
  }
  const system = new Set(['kernel32.dll', 'user32.dll', 'gdi32.dll', 'opengl32.dll', 'comctl32.dll', 'advapi32.dll',
    'shell32.dll', 'ole32.dll', 'oleaut32.dll', 'comdlg32.dll', 'winmm.dll', 'ws2_32.dll', 'crypt32.dll', 'bcrypt.dll',
    'secur32.dll', 'shlwapi.dll', 'd3d11.dll', 'dxgi.dll', 'dwmapi.dll', 'dcomp.dll', 'ntdll.dll', 'msvcrt.dll', 'ucrtbase.dll',
    'version.dll', 'imm32.dll', 'setupapi.dll', 'avrt.dll', 'powrprof.dll', 'winhttp.dll', 'normaliz.dll', 'iphlpapi.dll',
    'shcore.dll', 'uxtheme.dll', 'dwrite.dll', 'wldap32.dll', 'bcryptprimitives.dll', 'avicap32.dll', 'd2d1.dll', 'cfgmgr32.dll',
    'usp10.dll', 'rpcrt4.dll', 'msimg32.dll', 'ncrypt.dll', 'wsock32.dll', 'dnsapi.dll', 'gdiplus.dll'])
  const local = new Map()
  for (const binary of binaryFiles) {
    const key = path.basename(binary).toLowerCase()
    assert.ok(!local.has(key), 'ambiguous case-insensitive PE dependency')
    local.set(key, binary)
  }
  for (const dependency of [...dependencies, ...delayedDependencies]) {
    if (dependency === 'node.exe' && entry && delayedDependencies.includes(dependency)) continue
    if (system.has(dependency) || /^api-ms-win-[a-z0-9-]+\.dll$/.test(dependency)) continue
    assert.ok(local.has(dependency) && path.dirname(local.get(dependency)) === path.dirname(file),
      'PE dependency is absent from the adjacent runtime inventory: ' + dependency)
  }
  return { dependencies, delayedDependencies }
}

function inspectPlaybackBinary(file, input) {
  if (input.platformName === 'darwin') return inspectMacPlaybackBinary(file, input)
  if (input.platformName === 'linux') return inspectLinuxPlaybackBinary(file, input)
  if (input.platformName === 'win32') return inspectWindowsPlaybackBinary(file, input)
  throw new Error('native binary verification is not implemented for this platform')
}

/** Small packaging seam shared by preflight and the staged-resource check. */
export function validatePlaybackRuntime(directory, target, inspectBinary = inspectPlaybackBinary) {
  return validateRuntime(directory, target, inspectBinary, false)
}

/** Distribution inventory: binaries/notices plus a binding to the separate source archive. */
export function validatePackagedPlaybackRuntime(directory, target, inspectBinary = inspectPlaybackBinary) {
  return validateRuntime(directory, target, inspectBinary, true)
}

function validateRuntime(directory, target, inspectBinary, packaged) {
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'playback runtime must be a real directory')
  directory = realpathSync(directory)
  assert.ok(lstatSync(path.join(directory, 'runtime.json')).isFile()
    && !lstatSync(path.join(directory, 'runtime.json')).isSymbolicLink(), 'missing playback runtime inventory')
  assert.ok(lstatSync(path.join(directory, 'runtime.json')).size <= 1024 * 1024, 'playback runtime inventory is too large')
  const manifest = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, packaged ? 2 : 1, 'unsupported playback inventory schema')
  assert.equal(manifest.hashStage, 'pre-sign', 'playback inventory must describe pre-sign build inputs')
  for (const [key, value] of Object.entries({ platform: target.platformName, arch: target.archName, electronVersion: target.electronVersion })) {
    assert.equal(manifest[key], value, 'playback inventory target mismatch: ' + key)
  }
  assert.ok(['darwin', 'win32', 'linux'].includes(target.platformName) && ['arm64', 'x64'].includes(target.archName), 'unsupported playback target')
  assert.ok(text(manifest.electronVersion) && text(manifest.mpvVersion), 'missing playback build versions')
  assert.ok(manifest.files && !Array.isArray(manifest.files) && typeof manifest.files === 'object', 'missing playback file inventory')
  const names = Object.keys(manifest.files)
  assert.ok(names.length > 0 && names.length <= 1000, 'invalid playback inventory size')
  for (const name of names) {
    relativeFile(name)
    assert.notEqual(name, 'runtime.json', 'inventory cannot hash itself')
    assert.match(manifest.files[name], /^[a-f0-9]{64}$/, 'invalid playback file digest')
  }
  assert.deepEqual(filesIn(directory), [...names, 'runtime.json'].sort(), 'playback files do not exactly match their inventory')
  for (const name of names) assert.equal(digest(path.join(directory, name)), manifest.files[name], 'playback file digest mismatch: ' + name)
  if (packaged) {
    assert.ok(manifest.sourceBundle && typeof manifest.sourceBundle === 'object', 'missing corresponding source bundle')
    assert.ok(!relativeFile(manifest.sourceBundle.fileName).includes('/'), 'source bundle must be a sibling artifact')
    for (const field of ['sha256', 'inputInventorySha256', 'packagingToolsSha256']) assert.match(manifest.sourceBundle[field], /^[a-f0-9]{64}$/, 'invalid source bundle digest')
    assert.ok(names.includes('SOURCE-ACCESS.txt'), 'missing corresponding source access notice')
  }
  assert.ok(names.includes(target.platformName === 'linux' ? linuxPlaybackHelper : 'playback.node'),
    target.platformName === 'linux' ? 'missing Linux playback helper' : 'missing playback addon')
  if (target.platformName === 'linux') assert.ok(!names.includes('playback.node'), 'Linux playback uses an isolated helper, not an in-process addon')
  // The Windows shared-library closure includes over 100 separately sourced
  // packages. Keep an explicit bound without merging their source identities.
  assert.ok(Array.isArray(manifest.components) && manifest.components.length > 0 && manifest.components.length <= 128,
    'missing playback dependency/source inventory')
  const owners = new Map()
  const components = new Set()
  for (const component of manifest.components) {
    for (const field of ['name', 'version', 'license']) assert.ok(text(component[field]), 'missing component ' + field)
    assert.ok(!components.has(component.name), 'duplicate playback component')
    components.add(component.name)
    for (const field of ['licenseFile', 'sourceArchive', 'buildRecipe']) {
      const name = relativeFile(component[field])
      if (packaged && field !== 'licenseFile') {
        assert.ok(!names.includes(name) && !binary(name), 'source/build evidence must remain in the source bundle')
        continue
      }
      assert.ok(names.includes(name) && !binary(name) && lstatSync(path.join(directory, name)).size > 0, 'missing component evidence: ' + field)
    }
    assert.ok(Array.isArray(component.binaries) && component.binaries.length > 0, 'missing component binaries')
    for (const name of component.binaries) {
      relativeFile(name)
      assert.ok(names.includes(name) && binary(name), 'component binary is absent from inventory')
      assert.ok(!owners.has(name), 'duplicate playback binary ownership')
      owners.set(name, component.name)
    }
  }
  const mpv = manifest.components.find(component => component.name === 'mpv')
  assert.ok(mpv && mpv.version === manifest.mpvVersion
    && mpv.binaries.some(name => name !== 'playback.node' && name !== linuxPlaybackHelper), 'missing matching libmpv component')
  const binaryFiles = new Set(names.filter(binary).map(name => path.join(directory, name)))
  for (const file of binaryFiles) {
    assert.ok(owners.has(path.relative(directory, file).split(path.sep).join('/')), 'binary has no source/license owner')
    inspectBinary(file, { directory, platformName: target.platformName, archName: target.archName, binaryFiles })
  }
  if (packaged) {
    const allowed = new Set(['SOURCE-ACCESS.txt', ...owners.keys(), ...manifest.components.map(component => component.licenseFile)])
    assert.ok(names.every(name => allowed.has(name)), 'packaged playback contains non-runtime evidence')
  }
  return { directory, manifest, target, binaryCount: binaryFiles.size }
}

function createSourceBundle(input, context) {
  const output = path.resolve(context.packager.info.outDir ?? path.dirname(context.appOutDir))
  assert.ok(!inside(path.resolve(context.appOutDir), output), 'source bundle must remain outside the application')
  mkdirSync(output, { recursive: true })
  const inputInventorySha256 = digest(path.join(input.directory, 'runtime.json'))
  const sourceRoot = new URL('../', import.meta.url)
  const packagingFiles = ['scripts/playback-runtime.mjs', 'scripts/packaging-runtime.mjs', 'scripts/dist.mjs',
    'electron-builder.config.mjs', 'build/packaging.targets.json', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE']
  const packagingHash = createHash('sha256')
  for (const name of packagingFiles) packagingHash.update(name + '\0').update(readFileSync(new URL(name, sourceRoot)))
  const packagingToolsSha256 = packagingHash.digest('hex')
  const version = context.packager.appInfo?.version ?? JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.match(version, /^[a-zA-Z0-9.+_-]+$/, 'invalid source bundle version')
  const fileName = `Javdex-Playback-Sources-${version}-${input.target.platformName}-${input.target.archName}-${inputInventorySha256.slice(0, 12)}-${packagingToolsSha256.slice(0, 8)}.tar.gz`
  const archive = path.join(output, fileName), metadata = archive + '.json'
  if (existsSync(archive)) {
    const existing = JSON.parse(readFileSync(metadata, 'utf8'))
    assert.equal(existing.fileName, fileName, 'source bundle filename mismatch')
    assert.equal(existing.inputInventorySha256, inputInventorySha256, 'source bundle inventory mismatch')
    assert.equal(existing.packagingToolsSha256, packagingToolsSha256, 'source bundle packaging tools mismatch')
    assert.equal(existing.sha256, digest(archive), 'source bundle digest mismatch')
    return existing
  }
  const temporary = mkdtempSync(path.join(output, '.playback-sources-'))
  try {
    const payload = path.join(temporary, 'payload', 'reviewed-runtime')
    mkdirSync(payload, { recursive: true })
    for (const name of [...Object.keys(input.manifest.files).filter(name => !binary(name)), 'runtime.json']) {
      const destination = path.join(payload, name)
      mkdirSync(path.dirname(destination), { recursive: true })
      cpSync(path.join(input.directory, name), destination, { errorOnExist: true, force: false })
    }
    for (const name of packagingFiles) {
      const destination = path.join(temporary, 'payload', 'packaging-tools', name)
      mkdirSync(path.dirname(destination), { recursive: true })
      cpSync(new URL(name, sourceRoot), destination, { errorOnExist: true, force: false })
    }
    writeFileSync(path.join(temporary, 'payload', 'README.txt'), 'Corresponding playback source materials\n\nreviewed-runtime/runtime.json preserves the full pre-sign input inventory and binary hashes. Binaries are shipped in the application, not duplicated here. All reviewed non-binary evidence is retained in reviewed-runtime/. The native-toolchain source archive includes the Javdex source snapshot and build environment. packaging-tools/ supplies the current packaging scripts/configuration to apply to that snapshot when reconstructing the split distribution.\n')
    const bundled = path.join(temporary, 'sources.tar.gz')
    const result = spawnSync('tar', ['-czf', bundled, 'reviewed-runtime', 'packaging-tools', 'README.txt'], {
      cwd: path.dirname(payload), encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 4 * 1024 * 1024
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'could not create corresponding source bundle: ' + result.stderr)
    const descriptor = { fileName, sha256: digest(bundled), inputInventorySha256, packagingToolsSha256 }
    renameSync(bundled, archive)
    writeFileSync(metadata, JSON.stringify(descriptor, null, 2) + '\n')
    return descriptor
  } finally {
    assert.ok(inside(output, path.resolve(temporary)), 'temporary source bundle escaped output directory')
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function verifyPackagedPlaybackRuntime(context, { environment = process.env, inspectBinary } = {}) {
  const matrix = environment.JAVDEX_PLAYBACK_RUNTIME_DIR
  if (matrix === undefined) return null // Default development packages retain external playback.
  assert.ok(text(matrix), 'JAVDEX_PLAYBACK_RUNTIME_DIR must name a reviewed runtime matrix')
  const target = { platformName: context.electronPlatformName, archName: electronBuilderArchName(context.arch),
    electronVersion: context.packager.info.framework.version }
  return validatePlaybackRuntime(path.join(path.resolve(matrix), target.platformName + '-' + target.archName), target, inspectBinary)
}

export function stagePackagedPlaybackRuntime(context, options) {
  const input = verifyPackagedPlaybackRuntime(context, options)
  if (!input) return null
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), 'native-playback')
  assert.ok(!existsSync(destination), 'refusing to overwrite an existing packaged playback runtime')
  const sourceBundle = createSourceBundle(input, context)
  const included = new Set([...Object.keys(input.manifest.files).filter(binary), ...input.manifest.components.map(component => component.licenseFile)])
  assert.ok(!included.has('SOURCE-ACCESS.txt'), 'reserved source access notice path')
  mkdirSync(destination, { recursive: true })
  for (const name of included) {
    mkdirSync(path.dirname(path.join(destination, name)), { recursive: true })
    cpSync(path.join(input.directory, name), path.join(destination, name), { errorOnExist: true, force: false })
  }
  const notice = `Corresponding playback source and build materials are supplied separately:\n${sourceBundle.fileName}\nSHA-256: ${sourceBundle.sha256}\nReviewed input inventory SHA-256: ${sourceBundle.inputInventorySha256}\n\nObtain this companion archive alongside the installer/ZIP. It contains the reviewed-runtime input inventory, source archives, build recipes and original notices. Binary hashes in that input inventory identify the pre-sign binaries shipped in the application. Keep the source archive available with any distribution of these binaries.\n`
  writeFileSync(path.join(destination, 'SOURCE-ACCESS.txt'), notice)
  const manifest = { ...input.manifest, schemaVersion: 2, sourceBundle,
    files: { ...Object.fromEntries([...included].map(name => [name, input.manifest.files[name]])), 'SOURCE-ACCESS.txt': digest(path.join(destination, 'SOURCE-ACCESS.txt')) } }
  writeFileSync(path.join(destination, 'runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
  const staged = validatePackagedPlaybackRuntime(destination, input.target, options?.inspectBinary)
  console.log('Staged inventoried playback runtime: ' + input.target.platformName + '/' + input.target.archName + ', ' + staged.binaryCount + ' binaries')
  return staged
}
