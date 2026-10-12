// Development build only: release packaging must use an audited, relocatable runtime.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { playbackNativeBuild, stageWindowsDevelopmentLibraries } from './playback-native-build.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const platform = process.platform, arch = process.arch
if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error('Native playback adapter is not implemented for this host')
const prefix = process.env.JAVDEX_MPV_PREFIX ?? (platform === 'darwin' ? arch === 'arm64' ? '/opt/homebrew/opt/mpv' : '/usr/local/opt/mpv' : null)
if (!prefix) throw new Error('Set JAVDEX_MPV_PREFIX to an installed libmpv development prefix; dependencies are not downloaded automatically')
const electronDirectory = path.join(homedir(), '.electron-gyp', require('electron/package.json').version)
const include = process.env.JAVDEX_ELECTRON_HEADERS ?? path.join(electronDirectory, 'include/node')
const nodeLibrary = platform === 'win32' ? process.env.JAVDEX_ELECTRON_NODE_LIBRARY ?? path.join(electronDirectory, arch, 'node.lib') : undefined
let delayHook
if (platform === 'win32') {
  const rebuildRequire = createRequire(require.resolve('@electron/rebuild'))
  delayHook = path.join(path.dirname(rebuildRequire.resolve('node-gyp/package.json')), 'src/win_delay_load_hook.cc')
  if (!existsSync(delayHook)) throw new Error('Missing installed node-gyp delay-load hook; restore npm development dependencies')
}
if (!existsSync(path.join(prefix, 'include/mpv/client.h')) || !existsSync(path.join(include, 'node_api.h'))) {
  throw new Error('Missing libmpv development files or Electron headers. Set JAVDEX_MPV_PREFIX to your installed development prefix.')
}
if (nodeLibrary && !existsSync(nodeLibrary)) throw new Error('Missing matching Electron node.lib; set JAVDEX_ELECTRON_NODE_LIBRARY')
const output = path.join(root, 'out/native-playback')
mkdirSync(output, { recursive: true })
const environment = { ...process.env }
if (platform === 'win32') {
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'Path'
  environment[pathKey] = path.join(prefix, 'bin') + path.delimiter + (environment[pathKey] ?? '')
}
for (const step of playbackNativeBuild({ platform, arch, root, prefix, include, nodeLibrary, delayHook, output })) {
  const result = spawnSync(step.command, step.args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Native build or regression command failed: ' + step.command + ' (exit ' + result.status + ')')
}
if (platform === 'win32') {
  const files = stageWindowsDevelopmentLibraries({ output, libraryDirectory: path.join(prefix, 'bin'), arch })
  console.log(`Staged ${files.length} development playback DLLs beside playback.node`)
}
