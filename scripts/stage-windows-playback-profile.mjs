#!/usr/bin/env node
// Derive a new audited input directory from an existing complete inventory and
// locally rebuilt libraries. Never edit the original runtime or prune DLLs by
// filename guesswork: only the transitive PE import closure is copied.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { inspectWindowsPlaybackBinary, validatePlaybackRuntime } from './playback-runtime.mjs'
import { WINDOWS_PLAYBACK_FFMPEG_OPTIONS, WINDOWS_PLAYBACK_MPV_OPTIONS } from './build-windows-playback-libraries.mjs'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const required = name => { assert.ok(args.get(name), `Missing ${name}`); return path.resolve(args.get(name)) }
const original = required('--original'), prefix = required('--prefix'), destination = required('--destination')
const build = required('--build'), evidence = required('--evidence')
const toolchainLock = args.has('--toolchain-lock') ? required('--toolchain-lock') : path.join(evidence, 'toolchain-lock.json')
assert.ok(fs.existsSync(toolchainLock) && fs.statSync(toolchainLock).isFile(), 'Missing reviewed toolchain lock: ' + toolchainLock)
const target = { platformName: 'win32', archName: 'x64', electronVersion: '43.4.1' }
const input = validatePlaybackRuntime(original, target)
assert.ok(!fs.existsSync(destination) || fs.readdirSync(destination).length === 0, 'Destination must be empty')
const hash = file => {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024), digest = createHash('sha256')
  try { let size; while ((size = fs.readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, size)) }
  finally { fs.closeSync(fd) }
  return digest.digest('hex')
}
const copy = (from, name) => { const to = path.join(destination, name); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
const write = (name, contents) => { const file = path.join(destination, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents) }
const bins = path.join(prefix, 'bin')
// OpenGL is the Windows system WGL implementation. A development prefix may
// contain Mesa's same-named DLL; never let it enter this product's closure.
const candidates = fs.readdirSync(bins).filter(name => /\.dll$/i.test(name) && name.toLowerCase() !== 'opengl32.dll').map(name => path.join(bins, name))
const byName = new Map(candidates.map(file => [path.basename(file).toLowerCase(), file]))
const originalBinaries = Object.keys(input.manifest.files).filter(name => /\.(dll|node)$/i.test(name)).map(name => path.join(original, name))
const inspected = new Map()
const native = inspectWindowsPlaybackBinary(path.join(original, 'playback.node'), { directory: original, archName: 'x64', binaryFiles: originalBinaries })
const queue = [...native.dependencies, ...native.delayedDependencies].filter(name => byName.has(name))
while (queue.length) {
  const name = queue.shift()
  if (inspected.has(name)) continue
  const file = byName.get(name)
  const pe = inspectWindowsPlaybackBinary(file, { directory: bins, archName: 'x64', binaryFiles: candidates })
  inspected.set(name, { file, ...pe })
  queue.push(...[...pe.dependencies, ...pe.delayedDependencies].filter(dependency => byName.has(dependency)))
}
const selected = new Set(['playback.node', ...[...inspected.values()].map(value => path.basename(value.file))])
const ownerByName = new Map(input.manifest.components.flatMap(component => component.binaries.map(name => [name.toLowerCase(), component])))
for (const name of selected) assert.ok(ownerByName.has(name.toLowerCase()), `New binary needs a separate source/owner audit: ${name}`)
for (const name of ['libx265-217.dll', 'libx264-165.dll', 'libSvtAv1Enc-4.dll', 'librav1e.dll', 'xvidcore.dll', 'libpython3.14.dll', 'libvapoursynth-script-0.dll']) {
  assert.ok(!selected.has(name), `Playback-only build still imports ${name}`)
}
copy(path.join(original, 'playback.node'), 'playback.node')
for (const item of inspected.values()) copy(item.file, path.basename(item.file))
const components = []
const copied = new Set()
for (const component of input.manifest.components) {
  const binaries = component.binaries.filter(name => selected.has(name))
  if (!binaries.length) continue
  const next = { ...component, binaries }
  for (const name of [component.licenseFile, component.sourceArchive, component.buildRecipe]) {
    if (!copied.has(name)) { copy(path.join(original, name), name); copied.add(name) }
  }
  if (component.name === 'ffmpeg' || component.name === 'mpv') {
    next.version += '+javdex-playback1'
    next.buildRecipe = `recipes/${component.name}-javdex-playback.json`
    write(next.buildRecipe, JSON.stringify({ profile: 'javdex-windows-playback1', upstreamVersion: component.version,
      upstreamRecipe: component.buildRecipe, sourceArchive: component.sourceArchive,
      localBuildSources: 'sources/javdex-playback-build.tar.gz',
      options: component.name === 'ffmpeg' ? WINDOWS_PLAYBACK_FFMPEG_OPTIONS : WINDOWS_PLAYBACK_MPV_OPTIONS,
      rebuild: 'Use build-windows-playback-libraries.mjs from the localBuildSources archive with the audited dependency prefix and Clang toolchain. REBUILD.txt records the complete invocation and environment.',
      binaryHashes: Object.fromEntries(binaries.map(name => [name, hash(path.join(destination, name))])) }, null, 2) + '\n')
  }
  components.push(next)
}
const sourceEvidence = path.join(evidence, 'build-source-materials')
fs.mkdirSync(sourceEvidence, { recursive: true })
for (const name of ['build-windows-playback-libraries.mjs', 'stage-windows-playback-profile.mjs']) fs.copyFileSync(path.resolve('scripts', name), path.join(sourceEvidence, name))
for (const [name, file] of [['ffmpeg-config.h', path.join(build, 'ffmpeg/config.h')], ['ffmpeg-config-components.h', path.join(build, 'ffmpeg/config_components.h')],
  ['ffmpeg-config.log', path.join(build, 'ffmpeg/ffbuild/config.log')], ['ffmpeg-config.mak', path.join(build, 'ffmpeg/ffbuild/config.mak')],
  ['mpv-config.h', path.join(build, 'mpv/config.h')], ['mpv-build-options.json', path.join(build, 'mpv/meson-info/intro-buildoptions.json')],
  ['mpv-dependencies.json', path.join(build, 'mpv/meson-info/intro-dependencies.json')], ['preparation.json', path.join(evidence, 'preparation.json')]]) {
  fs.copyFileSync(file, path.join(sourceEvidence, name))
}
fs.copyFileSync(toolchainLock, path.join(sourceEvidence, 'toolchain-lock.json'))
fs.writeFileSync(path.join(sourceEvidence, 'REBUILD.txt'), `Javdex Windows playback profile 1\n\nOriginal reviewed input SHA-256: ${hash(path.join(original, 'runtime.json'))}\nClang 22.1.8 / FFmpeg 9.0.2 / mpv 0.41.0 / Meson 1.10.0\n\nExtract each selected component sourceArchive and rebuild dependencies with its supplied upstream recipe. Provide a matching Clang64 prefix with its headers/import libraries, NASM, pkgconf, ffnvcodec/vulkan headers, GNU Make/MSYS2, and Python with Meson 1.10.0. FFmpeg and mpv sources are pristine preferred archives; this build intentionally does not apply the upstream frei0r path-relocation patch because frei0r is disabled. Native addon playback.node is unchanged and retains its original native-toolchain source archive and recipe.\n\nnode build-windows-playback-libraries.mjs --sources <directory containing ffmpeg-9.0.2 and mpv-0.41.0> --prefix <dependency-prefix/clang64> --toolchain <clang64-toolchain> --msys <msys64> --python <python.exe> --work <empty-build-directory> --jobs 12\n\nThe exact options and generated FFmpeg/mpv configurations are supplied. This documents preferred source and the build environment, not byte-reproducible compiler output or code signing.\n`)
fs.mkdirSync(path.join(destination, 'sources'), { recursive: true })
const result = spawnSync('tar', ['-czf', path.join(destination, 'sources/javdex-playback-build.tar.gz'), '-C', sourceEvidence, '.'], { encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr)
write('LOCAL-BUILD-REVIEW.json', JSON.stringify({ originalInventorySha256: hash(path.join(original, 'runtime.json')), selectedBinaries: [...selected],
  omittedBinaries: originalBinaries.map(file => path.basename(file)).filter(name => !selected.has(name)),
  imports: Object.fromEntries(inspected), sourceMaterial: 'sources/javdex-playback-build.tar.gz' }, null, 2) + '\n')
const files = {}
function walk(directory) { for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
  const file = path.join(directory, item.name)
  if (item.isDirectory()) walk(file)
  else files[path.relative(destination, file).replaceAll('\\', '/')] = hash(file)
} }
walk(destination)
const manifest = { ...input.manifest, mpvVersion: components.find(component => component.name === 'mpv').version, components, files }
write('runtime.json', JSON.stringify(manifest, null, 2) + '\n')
const audited = validatePlaybackRuntime(destination, target)
const summary = { directory: destination, binaryCount: audited.binaryCount, components: components.length,
  binaryBytes: [...selected].reduce((sum, name) => sum + fs.statSync(path.join(destination, name)).size, 0),
  originalBinaryBytes: originalBinaries.reduce((sum, file) => sum + fs.statSync(file).size, 0),
  omittedBinaries: originalBinaries.map(file => path.basename(file)).filter(name => !selected.has(name)),
  runtimeInventorySha256: hash(path.join(destination, 'runtime.json')) }
fs.writeFileSync(path.join(evidence, 'runtime-review.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify(summary, null, 2))
