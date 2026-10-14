#!/usr/bin/env node
// Generates the reviewed packaging input from pinned preferred source. Outputs
// are task-owned build/cache artifacts; installed codec libraries are never copied.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { playbackBuildFingerprint, playbackLinuxAssDependency, playbackPkgConfigEnvironment, playbackSourceNativePlan, playbackSourcePlan, staticPlaybackDependencies, verifyPlaybackSource } from './playback-source-build.mjs'
import { playbackFileSha256, validatePlaybackRuntime } from './playback-runtime.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
const platform = process.platform, arch = process.arch
assert.ok(['darwin', 'linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch), 'Unsupported source build host')
assert.ok(platform !== 'win32' || arch === 'x64', 'Windows source build currently targets x64')
const lock = JSON.parse(readFileSync(path.join(root, 'build/playback-sources.json')))
const sources = lock.sources.filter(item => !item.platforms || item.platforms.includes(platform))
const electronVersion = require('electron/package.json').version
assert.equal(electronVersion, lock.sdk.electronVersion, 'Update the pinned playback SDK source/notice lock for this Electron version')
const work = path.join(root, 'out/playback-runtime-build'), cache = path.join(work, 'sources')
const matrix = path.resolve(process.env.JAVDEX_PLAYBACK_RUNTIME_DIR ?? path.join(root, 'out/playback-runtime'))
assert.ok(path.relative(root, matrix).startsWith('out' + path.sep), 'Build output must be under this checkout out directory')
const destination = path.join(matrix, `${platform}-${arch}`)
mkdirSync(work, { recursive: true }); mkdirSync(cache, { recursive: true }); mkdirSync(matrix, { recursive: true })
const environment = { ...process.env, LC_ALL: 'C', LANG: 'C' }
const msysRoot = platform === 'win32' ? environment.JAVDEX_PLAYBACK_MSYS2_ROOT : undefined
if (platform === 'win32') {
  assert.ok(msysRoot && path.win32.isAbsolute(msysRoot), 'Set JAVDEX_PLAYBACK_MSYS2_ROOT to the installed MSYS2 location')
  for (const file of ['usr/bin/bash.exe', 'usr/bin/make.exe', 'ucrt64/bin/gcc.exe'])
    assert.ok(existsSync(path.win32.join(msysRoot, file)), 'Missing source build tool: ' + file)
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'Path'
  environment[pathKey] = [path.win32.join(msysRoot, 'ucrt64/bin'), path.win32.join(msysRoot, 'usr/bin'), environment[pathKey] ?? ''].join(path.win32.delimiter)
  environment.MSYSTEM = 'UCRT64'
}
for (const name of ['JAVDEX_MPV_PREFIX', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'CPATH', 'LIBRARY_PATH', 'CMAKE_PREFIX_PATH', 'PKG_CONFIG_PATH', 'PKG_CONFIG_LIBDIR', 'GIT_DIR', 'GIT_WORK_TREE', 'OBJC', 'OBJCPP']) delete environment[name]
environment.GIT_CEILING_DIRECTORIES = work
// MSYS2 is a compiler/tool provider only. The actual runtime sources are the lock
// above. Bash performs the native/POSIX argument conversions for build tools.
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'"
const posix = value => platform === 'win32' ? String(value).replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => '/' + drive.toLowerCase() + '/') : value
function run(command, args = [], cwd = root, capture = false) {
  const windowsShell = platform === 'win32' && !/\.(exe|js|mjs)$/.test(command) && command !== process.execPath
  const actual = windowsShell ? path.win32.join(msysRoot, 'usr/bin/bash.exe') : command
  const parameters = windowsShell ? ['--noprofile', '--norc', '-c', [command, ...args].map(posix).map(quote).join(' ')] : args
  const result = spawnSync(actual, parameters, { cwd, env: environment, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed (${result.status}): ${result.stderr ?? ''}`)
  return capture ? result.stdout.trim() : ''
}
const compiler = platform === 'win32' ? 'gcc' : 'cc'
const python = platform === 'win32' && process.env.pythonLocation ? path.join(process.env.pythonLocation, 'python.exe') : 'python3'
environment.CC = compiler; environment.CXX = platform === 'win32' ? 'g++' : 'c++'
const toolchain = { compiler: run(compiler, ['--version'], root, true), cmake: run('cmake', ['--version'], root, true),
  python: run(python, ['--version'], root, true), make: run('make', ['--version'], root, true),
  ...(arch === 'x64' ? { nasm: run('nasm', ['--version'], root, true) } : {}),
  ...(platform === 'win32' ? { msysRoot, vcToolsVersion: process.env.VCToolsVersion, windowsSdkVersion: process.env.WindowsSDKVersion } : {}),
  ...(platform === 'linux' ? { systemApis: run('pkg-config', ['--modversion', 'x11', 'xft', 'fontconfig', 'alsa', 'libva'], root, true) } : {}),
  ...(platform === 'darwin' ? { sdk: run('xcrun', ['--show-sdk-version'], root, true), swift: run('swiftc', ['--version'], root, true), deploymentTarget: '12.0' } : {}) }
if (platform === 'darwin') environment.MACOSX_DEPLOYMENT_TARGET = '12.0'
const native = path.join(root, 'apps/desktop/src/main/player/native')
const recipeFiles = ['build/playback-sources.json', 'scripts/build-playback-runtime.mjs', 'scripts/playback-source-build.mjs',
  'scripts/playback-runtime.mjs', 'scripts/packaging-runtime.mjs', 'scripts/playback-native-build.mjs', 'scripts/check-playback-load.mjs', 'scripts/playback-linux-helper-smoke.mjs',
  'package.json', 'package-lock.json', 'LICENSE', 'NOTICE', 'LICENSES/Javdex-MIT.txt', 'LICENSES/node-gyp-MIT.txt',
  ...readdirSync(native).filter(name => /\.(cpp|mm|h)$|^CMakeLists.txt$/.test(name)).map(name => 'apps/desktop/src/main/player/native/' + name)]
for (const parent of ['apps', 'packages']) {
  for (const directory of readdirSync(path.join(root, parent), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const file = `${parent}/${directory.name}/package.json`
    if (existsSync(path.join(root, file))) recipeFiles.push(file)
  }
}
const fingerprint = playbackBuildFingerprint({ platform, arch, electronVersion, toolchain, files: recipeFiles.map(file => path.join(root, file)) })
const target = { platformName: platform, archName: arch, electronVersion }
if (process.argv.includes('--fingerprint')) {
  console.log(fingerprint)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `fingerprint=${fingerprint}\n`)
  process.exit(0)
}
if (existsSync(path.join(destination, 'runtime.json'))) {
  const receipt = JSON.parse(readFileSync(path.join(destination, 'build.json')))
  if (receipt.fingerprint === fingerprint) {
    validatePlaybackRuntime(destination, target)
    run(process.execPath, [path.join(root, 'scripts/check-playback-load.mjs'), destination])
    console.log(`Validated cached playback source build ${platform}/${arch}: ${fingerprint}`)
    process.exit(0)
  }
}

async function download(source) {
  const file = path.join(cache, source.filename)
  if (existsSync(file)) { verifyPlaybackSource(file, source); return file }
  for (let attempt = 0; attempt < 3; attempt++) {
    const partial = file + '.part'
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(180000) })
      assert.ok(response.ok, `Source download ${source.id}: HTTP ${response.status}`)
      const handle = await open(partial, 'w'); let bytes = 0
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length; assert.ok(bytes <= source.bytes, `Source exceeds pinned size: ${source.id}`)
          await handle.write(chunk)
        }
      } finally { await handle.close() }
      verifyPlaybackSource(partial, source); renameSync(partial, file); return file
    } catch (error) {
      if (existsSync(partial)) rmSync(partial)
      if (attempt === 2) throw error
      console.warn(`Retrying pinned source ${source.id}: ${error.message}`)
    }
  }
}
// A fresh source/build prefix for every changed fingerprint. Never re-use dirty
// configuration trees or a partially successful dependency installation.
const buildRoot = mkdtempSync(path.join(work, `${platform}-${arch}-`))
const sourceRoot = path.join(buildRoot, 'source'), build = path.join(buildRoot, 'build'), prefix = path.join(buildRoot, 'prefix')
for (const directory of [sourceRoot, build, prefix]) mkdirSync(directory, { recursive: true })
for (const source of sources) {
  console.log(`Pinned source: ${source.id} ${source.version}`)
  const file = await download(source), directory = path.join(sourceRoot, source.id)
  mkdirSync(directory); mkdirSync(path.join(build, source.id))
  run('tar', ['-xf', file, '--strip-components=1', '-C', directory])
  for (const license of source.licenseFiles) assert.ok(statSync(path.join(directory, license)).size > 0, `Missing source license: ${source.id}/${license}`)
}
cpSync(path.join(sourceRoot, 'fast_float'), path.join(sourceRoot, 'libplacebo/3rdparty/fast_float'), { recursive: true })
cpSync(path.join(sourceRoot, 'vulkan_headers'), path.join(sourceRoot, 'libplacebo/3rdparty/Vulkan-Headers'), { recursive: true })
const patches = []
for (const [id, dependencies] of [['mpv', ['libavcodec', 'libavfilter', 'libavformat', 'libavutil', 'libswresample', 'libswscale', 'libplacebo', 'libass', 'zlib']],
  ['libass', ['freetype2', 'fribidi', 'harfbuzz', 'libunibreak']]]) {
  if (platform === 'win32') dependencies.push('iconv')
  const file = path.join(sourceRoot, id, 'meson.build'), before = readFileSync(file, 'utf8')
  writeFileSync(file, staticPlaybackDependencies(before, dependencies)); patches.push({ id, dependencies, operation: 'dependency(..., static: true)' })
}
// Upstream probes these even with auto_features=disabled. Tie them to their
// explicit feature switches so a host's optional SDK does not enter the closure.
const mpvRecipe = path.join(sourceRoot, 'mpv/meson.build')
let mpvRecipeText = readFileSync(mpvRecipe, 'utf8')
if (platform === 'linux') {
  mpvRecipeText = playbackLinuxAssDependency(mpvRecipeText, path.join(prefix, 'bin/pkgconf'))
  patches.push({ id: 'mpv', operation: 'libass private archives with shared OS font provider dependencies' })
}
for (const [before, after] of [["dependency('sdl2', required: false)", "dependency('sdl2', required: get_option('sdl2-audio'))"],
  ["dependency('ffnvcodec', version: '>= 11.1.5.1', required: false)", "dependency('ffnvcodec', version: '>= 11.1.5.1', required: get_option('cuda-hwaccel'))"],
  ["dependency(version[0], version: version[1])", "dependency(version[0], static: true, version: version[1])"]]) {
  assert.equal(mpvRecipeText.split(before).length, 2, 'Pinned optional dependency recipe drift')
  mpvRecipeText = mpvRecipeText.replace(before, after); patches.push({ id: 'mpv', before, after })
}
writeFileSync(mpvRecipe, mpvRecipeText)
// Build tools live in this task's venv; no user-level pip or package-manager mutation.
const venv = path.join(work, `tools-${platform}-${arch}-${toolchain.python.replace(/[^a-zA-Z0-9.-]/g, '')}`)
const tools = path.join(venv, platform === 'win32' ? 'Scripts' : 'bin')
if (!existsSync(tools)) run(python, ['-m', 'venv', venv])
run(path.join(tools, platform === 'win32' ? 'python.exe' : 'python'), ['-m', 'pip', 'install', '--disable-pip-version-check',
  ...Object.entries(lock.tools).map(([name, version]) => `${name}==${version}`)])
const originalPath = environment.PATH ?? environment.Path ?? ''
delete environment.Path
environment.PATH = [tools, path.join(prefix, 'bin'), originalPath].join(path.delimiter)
Object.assign(environment, playbackPkgConfigEnvironment(prefix, platform, arch))
environment.PKG_CONFIG = posix(environment.PKG_CONFIG)
environment.CFLAGS = '-O2 -fPIC'; environment.CXXFLAGS = '-O2 -fPIC'
environment.CPPFLAGS = `-I${posix(path.join(prefix, 'include'))}`
environment.LDFLAGS = `-L${posix(path.join(prefix, 'lib'))}`
if (platform === 'win32') environment.LDFLAGS += ' -static -static-libgcc -static-libstdc++'
const jobs = Math.min(availableParallelism(), 8)
const plan = playbackSourcePlan({ platform, arch, source: sourceRoot, build, prefix, tools, jobs })
for (const step of plan) {
  console.log(`Source build: ${step.command} ${step.args.join(' ')}`)
  run(step.command, step.args, step.cwd)
  if (step.command === 'make' && step.args.includes('liblua.a')) {
    const lua = path.join(sourceRoot, 'lua/src'), include = path.join(prefix, 'include/lua5.2')
    mkdirSync(include, { recursive: true })
    for (const file of ['lua.h', 'lauxlib.h', 'lualib.h', 'luaconf.h']) cpSync(path.join(lua, file), path.join(include, file))
    cpSync(path.join(lua, 'liblua.a'), path.join(prefix, 'lib/liblua.a'))
    writeFileSync(path.join(prefix, 'lib/pkgconfig/lua5.2.pc'), `prefix=${prefix.replaceAll('\\', '/')}\nName: Lua\nDescription: Lua 5.2\nVersion: 5.2.4\nLibs: -L\${prefix}/lib -llua\nLibs.private: -lm${platform === 'linux' ? ' -ldl' : ''}\nCflags: -I\${prefix}/include/lua5.2\n`)
  }
}
// Matching Electron SDK in a task-owned cache; node-gyp verifies its checksums.
const rebuildRequire = createRequire(require.resolve('@electron/rebuild'))
const nodeGypRoot = path.dirname(rebuildRequire.resolve('node-gyp/package.json'))
const sdkCache = path.join(work, 'electron-headers')
run(process.execPath, [path.join(nodeGypRoot, 'bin/node-gyp.js'), 'install', `--target=${electronVersion}`, '--dist-url=https://electronjs.org/headers', `--devdir=${sdkCache}`, '--ensure'])
const sdk = path.join(sdkCache, electronVersion), include = path.join(sdk, 'include/node')
const versionHeader = readFileSync(path.join(include, 'node_version.h'), 'utf8')
const nodeVersion = ['MAJOR', 'MINOR', 'PATCH'].map(part => versionHeader.match(new RegExp(`NODE_${part}_VERSION\\s+(\\d+)`))?.[1]).join('.')
assert.equal(nodeVersion, lock.sdk.nodeVersion, 'Electron SDK Node headers differ from the pinned notice provenance')
const addon = path.join(buildRoot, 'adapter'); mkdirSync(addon)
const delayHook = path.join(nodeGypRoot, 'src/win_delay_load_hook.cc')
if (platform === 'win32') {
  // MSVC import library for the source-built MinGW libmpv, with a static CRT
  // for our addon. Generate from exports, not from an unrelated downloaded SDK.
  const dll = readdirSync(path.join(prefix, 'bin')).find(name => /^(lib)?mpv.*\.dll$/.test(name))
  assert.ok(dll, 'Source build did not install libmpv DLL')
  const exports = run('objdump', ['-p', path.join(prefix, 'bin', dll)], root, true)
  const names = [...exports.matchAll(/\[\s*\d+\]\s+(mpv_[a-zA-Z0-9_]+)\s*$/gm)].map(match => match[1])
  assert.ok(names.length > 20, 'Could not extract libmpv exports')
  const definition = path.join(buildRoot, 'mpv.def'); writeFileSync(definition, `LIBRARY ${dll}\nEXPORTS\n${names.join('\n')}\n`)
  // Visual Studio tools are added by the CI developer-command-prompt step.
  run('lib.exe', ['/machine:x64', `/def:${definition}`, `/out:${path.join(prefix, 'lib/mpv.lib')}`])
}
if (platform === 'win32') { environment.CC = 'cl'; environment.CXX = 'cl'; delete environment.CMAKE_GENERATOR }
const adapterPlan = playbackSourceNativePlan({ platform, arch, root, prefix, include,
  nodeLibrary: path.join(sdk, arch, 'node.lib'), delayHook, output: addon })
for (const step of adapterPlan) {
  // Test binaries still load from the private build prefix before relocation.
  if (platform === 'win32') environment.PATH = [path.join(prefix, 'bin'), tools, originalPath].join(path.delimiter)
  run(step.command, step.args, step.cwd)
}
const staged = path.join(buildRoot, 'runtime'); mkdirSync(staged)
const entry = platform === 'linux' ? 'playback-helper' : 'playback.node'
cpSync(path.join(addon, entry), path.join(staged, entry))
const libraryDirectory = path.join(prefix, platform === 'win32' ? 'bin' : 'lib')
const candidates = readdirSync(libraryDirectory).filter(name => platform === 'darwin' ? /^libmpv.*\.dylib$/.test(name)
  : platform === 'win32' ? /^(lib)?mpv.*\.dll$/.test(name) : /^libmpv\.so(?:\.\d+)*$/.test(name))
assert.ok(candidates.length > 0, 'Source build produced no libmpv')
// Resolve install-name/SONAME aliases to regular, hashable files.
const libraries = platform === 'darwin' ? [candidates.find(name => /^libmpv\.\d+\.dylib$/.test(name))] :
  platform === 'linux' ? [candidates.find(name => /^libmpv\.so\.\d+$/.test(name))] : candidates
assert.ok(libraries.every(Boolean), 'Missing canonical libmpv ABI filename')
for (const name of libraries) {
  const file = realpathSync(path.join(libraryDirectory, name))
  assert.ok(statSync(file).isFile(), `Canonical libmpv alias does not resolve to a regular file: ${file}`)
  copyFileSync(file, path.join(staged, name))
}
if (platform === 'darwin') {
  for (const name of [entry, ...libraries]) {
    const file = path.join(staged, name), commands = run('otool', ['-l', file], root, true)
    const ids = new Set([...commands.matchAll(/cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/g)].map(match => match[1]))
    if (ids.size) run('install_name_tool', ['-id', '@loader_path/' + name, file])
    for (const line of run('otool', ['-L', file], root, true).split('\n').filter(line => /^\s+/.test(line))) {
      const dependency = line.trim().replace(/ \(compatibility version.*$/, '')
      if (ids.has(dependency) || dependency === '@loader_path/' + name || dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/')) continue
      assert.ok(libraries.includes(path.basename(dependency)), 'Unplanned source build dependency: ' + dependency)
      run('install_name_tool', ['-change', dependency, '@loader_path/' + path.basename(dependency), file])
    }
    for (const match of commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)) run('install_name_tool', ['-delete_rpath', match[1], file])
    run('codesign', ['--force', '--sign', '-', file])
  }
} else if (platform === 'linux') {
  for (const name of [entry, ...libraries]) run('patchelf', ['--set-rpath', '$ORIGIN', path.join(staged, name)])
}
mkdirSync(path.join(staged, 'sources')); mkdirSync(path.join(staged, 'licenses'))
cpSync(path.join(prefix, 'include/mpv'), path.join(staged, 'sources/mpv'), { recursive: true })
const sourceDelivery = path.join(buildRoot, 'source-delivery'); mkdirSync(sourceDelivery)
const notices = []
const sdkNotices = []
for (const notice of lock.notices.filter(item => !item.platforms || item.platforms.includes(platform))) {
  const file = await download(notice)
  cpSync(file, path.join(sourceDelivery, notice.filename))
  sdkNotices.push(`\n=== ${notice.id} ${notice.url} ===\n` + readFileSync(file, 'utf8'))
}
for (const source of sources) {
  cpSync(path.join(cache, source.filename), path.join(sourceDelivery, source.filename))
  notices.push(`\n=== ${source.id} ${source.version} (${source.license}) ${source.url} ===\n`)
  for (const file of source.licenseFiles) notices.push(readFileSync(path.join(sourceRoot, source.id, file), 'utf8'))
}
writeFileSync(path.join(staged, 'licenses/libmpv.txt'), notices.join('\n') + '\n' + sdkNotices.join('\n'))
run('tar', ['-cf', path.join(staged, 'sources/libmpv-sources.tar'), '-C', sourceDelivery, '.'])
const adapterSource = path.join(buildRoot, 'adapter-source'); mkdirSync(adapterSource)
for (const file of recipeFiles) { mkdirSync(path.dirname(path.join(adapterSource, file)), { recursive: true }); cpSync(path.join(root, file), path.join(adapterSource, file)) }
cpSync(path.join(sdk, 'include'), path.join(adapterSource, 'electron-sdk/include'), { recursive: true })
for (const notice of lock.notices.filter(item => !item.platforms || item.platforms.includes(platform))) cpSync(path.join(cache, notice.filename), path.join(adapterSource, notice.filename))
if (platform === 'win32') {
  cpSync(delayHook, path.join(adapterSource, 'win_delay_load_hook.cc'))
  cpSync(path.join(nodeGypRoot, 'LICENSE'), path.join(adapterSource, 'node-gyp-LICENSE'))
}
run('tar', ['-czf', path.join(staged, 'sources/javdex-native.tar.gz'), '-C', adapterSource, '.'])
writeFileSync(path.join(staged, 'licenses/javdex.txt'), readFileSync(path.join(root, 'LICENSE'), 'utf8') +
  '\n\n' + sdkNotices.join('\n') +
  (platform === 'win32' ? '\n\nElectron delay-load hook (node-gyp):\n' + readFileSync(path.join(nodeGypRoot, 'LICENSE'), 'utf8') : ''))
const receipt = { schemaVersion: 1, fingerprint, platform, arch, electronVersion, sdk: lock.sdk, toolchain, tools: lock.tools,
  sources: sources.map(({ licenseFiles, ...item }) => item), staticDependencies: patches, commands: [...plan, ...adapterPlan],
  rebuild: 'Extract javdex-native.tar.gz into a checkout, npm ci, restore source archives under out/playback-runtime-build/sources, then npm run playback:runtime:build on the recorded native host.' }
writeFileSync(path.join(staged, 'build.json'), JSON.stringify(receipt, null, 2) + '\n')
const files = {}
function inventory(directory, relative = '') {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    assert.ok(!file.isSymbolicLink(), 'Source build inventory cannot contain symlinks')
    const name = relative + file.name
    if (file.isDirectory()) inventory(path.join(directory, file.name), name + '/')
    else files[name] = playbackFileSha256(path.join(directory, file.name))
  }
}
inventory(staged)
writeFileSync(path.join(staged, 'runtime.json'), JSON.stringify({ schemaVersion: 1, hashStage: 'pre-sign', platform, arch, electronVersion,
  mpvVersion: lock.sources.find(item => item.id === 'mpv').version, files, components: [
    { name: 'mpv', version: lock.sources.find(item => item.id === 'mpv').version, license: 'GPL-3.0-or-later', binaries: libraries,
      licenseFile: 'licenses/libmpv.txt', sourceArchive: 'sources/libmpv-sources.tar', buildRecipe: 'build.json' },
    { name: 'javdex-native', version: require('../package.json').version, license: 'GPL-3.0-or-later', binaries: [entry],
      licenseFile: 'licenses/javdex.txt', sourceArchive: 'sources/javdex-native.tar.gz', buildRecipe: 'build.json' }
  ] }, null, 2) + '\n')
validatePlaybackRuntime(staged, target)
run(process.execPath, [path.join(root, 'scripts/check-playback-load.mjs'), staged])
// Only replace an earlier generated target after the complete build validates.
if (existsSync(destination)) renameSync(destination, path.join(work, `previous-${platform}-${arch}-${Date.now()}`))
renameSync(staged, destination)
console.log(`Playback source build ready: ${destination} (${fingerprint})`)
