import path from 'node:path'
import assert from 'node:assert/strict'
import { copyFileSync, readdirSync } from 'node:fs'
import { inspectWindowsPlaybackBinary } from './playback-runtime.mjs'

// Development only. The addon must load under npm dev/start without a shell's
// libmpv PATH. Release packaging still requires its separate audited inventory.
export function stageWindowsDevelopmentLibraries({ output, libraryDirectory, arch }) {
  output = path.resolve(output)
  libraryDirectory = path.resolve(libraryDirectory)
  assert.notEqual(output, libraryDirectory, 'Development output must differ from the library directory')
  const candidates = readdirSync(libraryDirectory)
    .filter(name => /\.dll$/i.test(name) && name.toLowerCase() !== 'opengl32.dll')
    .map(name => path.join(libraryDirectory, name))
  const byName = new Map(candidates.map(file => [path.basename(file).toLowerCase(), file]))
  assert.equal(byName.size, candidates.length, 'Ambiguous development DLL names')
  const addon = path.join(output, 'playback.node')
  const native = inspectWindowsPlaybackBinary(addon, { directory: output, archName: arch,
    binaryFiles: [addon, ...candidates.map(file => path.join(output, path.basename(file)))] })
  const selected = new Map()
  const queue = [...native.dependencies, ...native.delayedDependencies]
  while (queue.length) {
    const name = queue.shift()
    if (selected.has(name) || !byName.has(name)) continue
    const file = byName.get(name)
    const inspected = inspectWindowsPlaybackBinary(file, { directory: libraryDirectory, archName: arch, binaryFiles: candidates })
    selected.set(name, file)
    queue.push(...inspected.dependencies, ...inspected.delayedDependencies)
  }
  // Validate the whole closure before copying; missing/wrong-architecture DLLs
  // must fail the build, rather than leave a seemingly usable development addon.
  const files = [...selected.values()].map(file => path.join(output, path.basename(file)))
  for (const file of selected.values()) copyFileSync(file, path.join(output, path.basename(file)))
  for (const file of [addon, ...files]) inspectWindowsPlaybackBinary(file, {
    directory: output, archName: arch, binaryFiles: [addon, ...files] })
  return files
}

/** Development build commands only; no SDK download, cross-platform claim or
 * release runtime staging. The driver checks the selected host's real inputs. */
export function playbackNativeBuild({ platform, arch, root, prefix, include, nodeLibrary, delayHook, output }) {
  const source = path.join(root, 'apps/desktop/src/main/player/native')
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported native playback architecture')
  if (platform === 'darwin') {
    const navigation = path.join(output, 'navigation-key-test'), core = path.join(output, 'mpv-core-test')
    const architecture = ['-arch', arch === 'x64' ? 'x86_64' : 'arm64']
    return [
      { command: 'clang++', args: ['-std=c++17', ...architecture, path.join(source, 'macNavigationKey.test.cpp'), '-o', navigation] },
      { command: navigation, args: [] },
      { command: 'clang++', args: ['-std=c++17', ...architecture, `-I${include}`, `-I${prefix}/include`, path.join(source, 'mpvCore.test.cpp'),
        `-L${prefix}/lib`, '-lmpv', '-o', core] },
      { command: core, args: [] },
      { command: 'clang++', args: ['-std=c++17', ...architecture, '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup', '-Wno-deprecated-declarations',
        `-I${include}`, `-I${prefix}/include`, path.join(source, 'macPlayback.mm'), `-L${prefix}/lib`, '-lmpv',
        '-framework', 'Cocoa', '-framework', 'OpenGL', '-o', path.join(output, 'playback.node')] }
    ]
  }
  if (platform === 'win32') {
    if (!nodeLibrary) throw new Error('Windows requires the matching Electron node.lib')
    if (!delayHook) throw new Error('Windows requires the installed node-gyp delay-load hook')
    const build = path.join(output, 'cmake')
    return [
      { command: 'cmake', args: ['-S', source, '-B', build, '-A', arch === 'x64' ? 'x64' : 'ARM64',
        `-DELECTRON_INCLUDE_DIR=${include}`, `-DELECTRON_NODE_LIBRARY=${nodeLibrary}`, `-DELECTRON_DELAY_LOAD_HOOK=${delayHook}`,
        `-DMPV_PREFIX=${prefix}`, `-DPLAYBACK_OUTPUT_DIR=${output}`] },
      { command: 'cmake', args: ['--build', build, '--config', 'Release'] },
      { command: path.join(output, 'mpv-core-test.exe'), args: [] },
      { command: path.join(output, 'slider-feedback-test.exe'), args: [] }
    ]
  }
  if (platform === 'linux') {
    const build = path.join(output, 'cmake')
    return [
      { command: 'cmake', args: ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release',
        `-DELECTRON_INCLUDE_DIR=${include}`, `-DMPV_PREFIX=${prefix}`, `-DPLAYBACK_OUTPUT_DIR=${output}`] },
      { command: 'cmake', args: ['--build', build, '--config', 'Release'] },
      { command: path.join(output, 'mpv-core-test'), args: [] },
      { command: path.join(output, 'x11-controls-test'), args: [] },
      { command: process.execPath, args: [path.join(root, 'scripts/playback-linux-helper-smoke.mjs'), path.join(output, 'playback-helper')] }
    ]
  }
  throw new Error('Native playback adapter is not implemented for this host')
}
