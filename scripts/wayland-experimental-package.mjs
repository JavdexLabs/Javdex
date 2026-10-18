// Separate, explicitly experimental packaging. The release runtime validator and
// source-delivery hooks remain unchanged and still validate the reviewed runtime.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePlaybackRuntime } from './playback-runtime.mjs'

export const EXPERIMENTAL_VERSION = '0.9.1-linux-texture.2'
export const EXPERIMENTAL_OUTPUT = 'dist/cpu-frame-experimental'
export const EXPERIMENTAL_DIRECTORY = 'linux-texture-experimental'
export const experimentalRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binaries = ['playback-fd.node', 'playback-dmabuf-helper', 'playback-cpu-helper', 'libmpv.so.2']
const notices = ['LICENSE', 'libmpv-LICENSE.txt', 'SOURCE-ACCESS.txt']
const fontFiles = ['NotoSans-Regular.ttf', 'LICENSE.txt', 'SOURCE.json']
const fontResources = fontFiles.map(name => `fonts/${name}`)
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const systemLibraries = new Set([
  'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1',
  'libgcc_s.so.1', 'libstdc++.so.6', 'libX11.so.6', 'libXext.so.6', 'libxcb.so.1',
  'libXrender.so.1', 'libXft.so.2', 'libfontconfig.so.1', 'libfreetype.so.6',
  'libXrandr.so.2', 'libXss.so.1', 'libXpresent.so.1', 'libGL.so.1', 'libGLX.so.0',
  'libOpenGL.so.0', 'libGLdispatch.so.0', 'libEGL.so.1', 'libasound.so.2',
  'libva.so.2', 'libva-drm.so.2', 'libva-x11.so.2', 'libgbm.so.1', 'libdrm.so.2',
  'ld-linux-x86-64.so.2'
])
function run(command, args, cwd = experimentalRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command}: ${result.stderr}`)
  return result.stdout
}
function versionMaximum(text, prefix) {
  return [...new Set(text.match(new RegExp(`${prefix}_[0-9.]+`, 'g')) ?? [])].sort((a, b) => {
    const left = a.slice(prefix.length + 1).split('.').map(Number)
    const right = b.slice(prefix.length + 1).split('.').map(Number)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = (left[i] ?? 0) - (right[i] ?? 0)
      if (difference) return difference
    }
    return 0
  }).at(-1) ?? null
}
export function inspectExperimentalElf(file) {
  const data = fs.readFileSync(file), name = path.basename(file)
  const helper = name === 'playback-dmabuf-helper' || name === 'playback-cpu-helper'
  assert.ok(data.length >= 64 && data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'Experimental binary must be ELF')
  assert.ok(data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === 62, 'Experimental binary must be little-endian Linux x86_64')
  assert.ok(data.readUInt16LE(16) === 3 || (helper && data.readUInt16LE(16) === 2), 'Invalid experimental ELF type')
  if (helper) {
    assert.ok(fs.statSync(file).mode & 0o111, 'Experimental helper must be executable')
    assert.ok(data.readBigUInt64LE(24) !== 0n, 'Experimental helper needs an entry point')
    const programHeaders = run('readelf', ['-lW', file])
    assert.match(programHeaders, /Requesting program interpreter: \/(?:lib64|lib\/x86_64-linux-gnu)\/ld-linux-x86-64\.so\.2\]/)
  }
  const dynamic = run('readelf', ['-dW', file])
  assert.match(dynamic, /\(NULL\)/)
  assert.ok(!/\((AUDIT|DEPAUDIT|FILTER|AUXILIARY)\)/.test(dynamic), 'Unsupported ELF dependency indirection')
  for (const [, search] of dynamic.matchAll(/\((?:RPATH|RUNPATH)\)[^\n]*\[([^\]]*)\]/g))
    assert.ok(search.split(':').every(value => value === '$ORIGIN'), 'Experimental ELF runtime paths must be $ORIGIN only')
  const dependencies = [...dynamic.matchAll(/\(NEEDED\)[^\n]*\[([^\]]+)\]/g)].map(match => match[1])
  for (const dependency of dependencies)
    assert.ok(systemLibraries.has(dependency) || dependency === 'libmpv.so.2', `Unexpected experimental dependency: ${dependency}`)
  if (dependencies.includes('libmpv.so.2')) assert.match(dynamic, /\((?:RPATH|RUNPATH)\)[^\n]*\[\$ORIGIN\]/)
  if (helper) assert.ok(dependencies.includes('libmpv.so.2'), 'Experimental helper must link reviewed libmpv')
  if (name === 'playback-fd.node') assert.ok(!dependencies.includes('libmpv.so.2'), 'FD bridge must not load libmpv into Electron')
  const symbols = run('readelf', ['--version-info', file])
  return { dependencies, glibc: versionMaximum(symbols, 'GLIBC'), glibcxx: versionMaximum(symbols, 'GLIBCXX') }
}
function realRegularFile(file) {
  const stat = fs.lstatSync(file)
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected regular file: ${file}`)
}
export function verifyExperimentalRuntime(directory, { sourceDirectory, inspect = inspectExperimentalElf } = {}) {
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink())
  realRegularFile(path.join(directory, 'experimental-runtime.json'))
  assert.ok(fs.statSync(path.join(directory, 'experimental-runtime.json')).size < 1024 * 1024)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'experimental-runtime.json')))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.experimental, true)
  assert.equal(manifest.platform, 'linux')
  assert.equal(manifest.arch, 'x64')
  assert.equal(manifest.electronVersion, '43.8.0')
  assert.equal(manifest.version, EXPERIMENTAL_VERSION)
  assert.equal(manifest.mpvVersion, '0.41.0')
  assert.deepEqual(Object.keys(manifest.files).sort(), [...binaries, ...notices, ...fontResources].sort())
  assert.deepEqual(fs.readdirSync(directory).sort(), [...binaries, ...notices, 'fonts', 'experimental-runtime.json'].sort())
  const fonts = path.join(directory, 'fonts')
  assert.ok(fs.lstatSync(fonts).isDirectory() && !fs.lstatSync(fonts).isSymbolicLink(), 'Expected regular font directory')
  assert.deepEqual(fs.readdirSync(fonts).sort(), [...fontFiles].sort())
  for (const name of Object.keys(manifest.files)) {
    const file = path.join(directory, name)
    realRegularFile(file)
    assert.match(manifest.files[name], /^[a-f0-9]{64}$/)
    assert.equal(sha256(file), manifest.files[name], `Experimental runtime hash mismatch: ${name}`)
  }
  assert.equal(manifest.files['libmpv.so.2'], manifest.reviewedLibmpvSha256)
  assert.equal(path.basename(manifest.sourceBundle.fileName), manifest.sourceBundle.fileName)
  assert.match(manifest.sourceBundle.sha256, /^[a-f0-9]{64}$/)
  if (sourceDirectory) {
    const file = path.join(sourceDirectory, manifest.sourceBundle.fileName)
    realRegularFile(file)
    assert.equal(sha256(file), manifest.sourceBundle.sha256, 'Experimental corresponding source archive mismatch')
  }
  for (const name of binaries) assert.deepEqual(inspect(path.join(directory, name)), manifest.elf[name])
  return manifest
}
export function prepareExperimentalRuntime(context) {
  assert.equal(context.electronPlatformName, 'linux')
  assert.equal(context.packager.info.framework.version, '43.8.0')
  assert.equal(context.packager.appInfo.version, EXPERIMENTAL_VERSION)
  const matrix = process.env.JAVDEX_PLAYBACK_RUNTIME_DIR
  assert.ok(matrix, 'Experimental packaging requires the complete reviewed playback source/runtime input')
  const reviewed = validatePlaybackRuntime(path.join(matrix, 'linux-x64'), { platformName: 'linux', archName: 'x64', electronVersion: '43.8.0' })
  const output = path.resolve(context.packager.info.outDir ?? path.dirname(context.appOutDir))
  fs.mkdirSync(output, { recursive: true })
  const work = fs.mkdtempSync(path.join(output, '.linux-texture-'))
  const sourceRoot = path.join(work, 'source'), runtime = path.join(work, 'runtime')
  fs.mkdirSync(sourceRoot); fs.mkdirSync(runtime)
  try {
    const sourceFiles = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    for (const name of sourceFiles) {
      assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'))
      const file = path.join(experimentalRoot, name)
      if (!fs.existsSync(file)) continue
      realRegularFile(file)
      fs.mkdirSync(path.dirname(path.join(sourceRoot, name)), { recursive: true })
      fs.copyFileSync(file, path.join(sourceRoot, name))
    }
    // Preserve exact third-party source archives, build recipes and notices from
    // the verified release input; never substitute a source URL for these bytes.
    fs.cpSync(path.join(reviewed.directory, 'sources'), path.join(sourceRoot, 'reviewed-playback/sources'), { recursive: true })
    for (const name of ['build.json', 'runtime.json']) fs.copyFileSync(path.join(reviewed.directory, name), path.join(sourceRoot, 'reviewed-playback', name))
    fs.cpSync(path.join(reviewed.directory, 'licenses'), path.join(sourceRoot, 'reviewed-playback/licenses'), { recursive: true })
    fs.writeFileSync(path.join(sourceRoot, 'EXPERIMENTAL-BUILD.json'), JSON.stringify({
      version: EXPERIMENTAL_VERSION, sourceBase: run('git', ['rev-parse', 'HEAD']).trim(),
      sourceStatus: run('git', ['status', '--short']),
      builtAt: new Date().toISOString(), compiler: run('c++', ['--version']).split('\n')[0],
      recipe: 'docs/LINUX_TEXTURE_EXPERIMENTAL.md',
      reviewedRuntimeSha256: sha256(path.join(reviewed.directory, 'runtime.json')),
      validation: 'See docs/LINUX_CPU_FRAME_EXPERIMENT.md and separately delivered test evidence. CPU acceptance does not establish DMA-BUF or native Wayland acceptance.'
    }, null, 2) + '\n')
    const sourceName = `Javdex-Linux-Texture-Experimental-Sources-${EXPERIMENTAL_VERSION}.tar.gz`
    const archive = path.join(output, sourceName)
    run('tar', ['-czf', archive, '-C', sourceRoot, '.'])
    for (const name of binaries) {
      const file = name === 'libmpv.so.2' ? path.join(reviewed.directory, name) : path.join(experimentalRoot, 'out/native-playback', name)
      realRegularFile(file); fs.copyFileSync(file, path.join(runtime, name))
      fs.chmodSync(path.join(runtime, name), 0o755)
    }
    const fontSource = path.join(experimentalRoot, 'resources/linux-cpu-fonts')
    assert.deepEqual(fs.readdirSync(fontSource).sort(), [...fontFiles].sort())
    for (const name of fontFiles) realRegularFile(path.join(fontSource, name))
    const fontLock = JSON.parse(fs.readFileSync(path.join(fontSource, 'SOURCE.json'), 'utf8'))
    assert.equal(fontLock.fileName, 'NotoSans-Regular.ttf')
    assert.equal(fontLock.license, 'OFL-1.1')
    assert.equal(fontLock.sha256, sha256(path.join(fontSource, fontLock.fileName)), 'Bundled subtitle font does not match its source lock')
    assert.equal(fontLock.bytes, fs.statSync(path.join(fontSource, fontLock.fileName)).size)
    fs.cpSync(fontSource, path.join(runtime, 'fonts'), { recursive: true })
    fs.copyFileSync(path.join(experimentalRoot, 'LICENSE'), path.join(runtime, 'LICENSE'))
    fs.copyFileSync(path.join(reviewed.directory, 'licenses/libmpv.txt'), path.join(runtime, 'libmpv-LICENSE.txt'))
    fs.writeFileSync(path.join(runtime, 'SOURCE-ACCESS.txt'), `Experimental testing build, not a production release.\nCorresponding complete source, build recipes and third-party materials accompany this AppImage as ${sourceName}.\nSHA-256: ${sha256(archive)}\nThe reviewed X11 runtime has its own separate source archive and unchanged audit gate.\n`)
    const manifest = { schemaVersion: 1, experimental: true, platform: 'linux', arch: 'x64', version: EXPERIMENTAL_VERSION,
      electronVersion: '43.8.0', mpvVersion: reviewed.manifest.mpvVersion,
      reviewedLibmpvSha256: reviewed.manifest.files['libmpv.so.2'],
      sourceBundle: { fileName: sourceName, sha256: sha256(archive) },
      files: Object.fromEntries([...binaries, ...notices, ...fontResources].map(name => [name, sha256(path.join(runtime, name))])),
      elf: Object.fromEntries(binaries.map(name => [name, inspectExperimentalElf(path.join(runtime, name))])) }
    fs.writeFileSync(path.join(runtime, 'experimental-runtime.json'), JSON.stringify(manifest, null, 2) + '\n')
    verifyExperimentalRuntime(runtime, { sourceDirectory: output })
    const staged = path.join(experimentalRoot, 'out', EXPERIMENTAL_DIRECTORY)
    fs.rmSync(staged, { recursive: true, force: true }); fs.renameSync(runtime, staged)
    return staged
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
}
export function stageExperimentalRuntime(context) {
  const staged = path.join(experimentalRoot, 'out', EXPERIMENTAL_DIRECTORY)
  verifyExperimentalRuntime(staged, { sourceDirectory: path.resolve(context.packager.info.outDir ?? path.dirname(context.appOutDir)) })
  const destination = path.join(context.packager.getResourcesDir(context.appOutDir), EXPERIMENTAL_DIRECTORY)
  assert.ok(!fs.existsSync(destination), 'Refusing to replace an existing packaged experimental runtime')
  fs.cpSync(staged, destination, { recursive: true, errorOnExist: true, force: false })
  verifyExperimentalRuntime(destination, { sourceDirectory: path.resolve(context.packager.info.outDir ?? path.dirname(context.appOutDir)) })
  // electron-builder first generates its launcher, then overlays appOutDir.
  // Supply our own launcher so namespace failure can never disable sandboxing.
  const launcher = path.join(context.appOutDir, 'AppRun')
  fs.copyFileSync(path.join(experimentalRoot, 'build/linux-texture-AppRun.sh'), launcher)
  fs.chmodSync(launcher, 0o755)
}
