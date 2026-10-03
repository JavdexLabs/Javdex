// Packaging inputs only. This verifies an inventory, not license compliance or
// playback acceptance; a build cannot turn development Homebrew files into a release.
import assert from 'node:assert/strict'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { electronBuilderArchName } from './packaging-runtime.mjs'

const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
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

function inspectPlaybackBinary(file, input) {
  if (input.platformName === 'darwin') return inspectMacPlaybackBinary(file, input)
  if (input.platformName === 'linux') return inspectLinuxPlaybackBinary(file, input)
  throw new Error('native binary verification is not implemented for this platform')
}

/** Small packaging seam shared by preflight and the staged-resource check. */
export function validatePlaybackRuntime(directory, target, inspectBinary = inspectPlaybackBinary) {
  assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'playback runtime must be a real directory')
  directory = realpathSync(directory)
  assert.ok(lstatSync(path.join(directory, 'runtime.json')).isFile()
    && !lstatSync(path.join(directory, 'runtime.json')).isSymbolicLink(), 'missing playback runtime inventory')
  assert.ok(lstatSync(path.join(directory, 'runtime.json')).size <= 1024 * 1024, 'playback runtime inventory is too large')
  const manifest = JSON.parse(readFileSync(path.join(directory, 'runtime.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1, 'unsupported playback inventory schema')
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
  assert.ok(names.includes(target.platformName === 'linux' ? linuxPlaybackHelper : 'playback.node'),
    target.platformName === 'linux' ? 'missing Linux playback helper' : 'missing playback addon')
  if (target.platformName === 'linux') assert.ok(!names.includes('playback.node'), 'Linux playback uses an isolated helper, not an in-process addon')
  assert.ok(Array.isArray(manifest.components) && manifest.components.length > 0 && manifest.components.length <= 100,
    'missing playback dependency/source inventory')
  const owners = new Map()
  const components = new Set()
  for (const component of manifest.components) {
    for (const field of ['name', 'version', 'license']) assert.ok(text(component[field]), 'missing component ' + field)
    assert.ok(!components.has(component.name), 'duplicate playback component')
    components.add(component.name)
    for (const field of ['licenseFile', 'sourceArchive', 'buildRecipe']) {
      const name = relativeFile(component[field])
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
    assert.ok(['darwin', 'linux'].includes(target.platformName), 'native binary verification is not implemented for this platform')
    inspectBinary(file, { directory, platformName: target.platformName, archName: target.archName, binaryFiles })
  }
  return { directory, manifest, target, binaryCount: binaryFiles.size }
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
  mkdirSync(path.dirname(destination), { recursive: true })
  cpSync(input.directory, destination, { recursive: true, errorOnExist: true, force: false })
  const staged = validatePlaybackRuntime(destination, input.target, options?.inspectBinary)
  console.log('Staged inventoried playback runtime: ' + input.target.platformName + '/' + input.target.archName + ', ' + staged.binaryCount + ' binaries')
  return staged
}
