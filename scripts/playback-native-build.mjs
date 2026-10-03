import path from 'node:path'

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
      { command: path.join(output, 'mpv-core-test.exe'), args: [] }
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
