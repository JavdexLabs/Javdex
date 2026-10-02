// macOS-only throwaway verification. Never starts the normal application.
import { build } from 'esbuild'
import { spawnSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
if (process.platform !== 'darwin') throw new Error('This prototype verifies macOS only; Windows/Linux adapters are not implemented.')
const output = join(root, 'out/libmpv-prototype')
const source = join(root, 'apps/desktop/src/main/player/libmpvPrototype')
mkdirSync(output, { recursive: true })
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
const prefixResult = spawnSync('brew', ['--prefix', 'mpv'], { encoding: 'utf8' })
if (prefixResult.status !== 0) throw new Error('Install mpv development dependencies first: brew install mpv')
const prefix = prefixResult.stdout.trim()
const version = require('electron/package.json').version
const include = join(homedir(), '.electron-gyp', version, 'include/node')
if (!existsSync(join(include, 'node_api.h'))) throw new Error(`Missing Electron headers; run npm run setup:desktop (${include})`)
run('clang++', ['-std=c++17', '-fobjc-arc', '-shared', '-undefined', 'dynamic_lookup', '-Wno-deprecated-declarations',
  `-I${include}`, `-I${prefix}/include`, join(source, 'nativeBridge.mm'), `-L${prefix}/lib`, '-lmpv',
  '-framework', 'Cocoa', '-framework', 'OpenGL', '-o', join(output, 'nativeBridge.node')])

// Synthetic patterns + quiet tone, no personal media. Keep generated files in ignored out/.
const media = [join(output, 'h264-aac.mp4'), join(output, 'hevc-main10-aac.mkv')]
for (const [index, file] of media.entries()) {
  if (existsSync(file)) continue
  const video = index === 0
    ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
    : ['-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error']
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '18', ...video,
    '-c:a', 'aac', '-b:a', '128k', '-y', file])
}
await build({ entryPoints: [join(source, 'main.ts')], outfile: join(output, 'main.cjs'), bundle: true,
  platform: 'node', format: 'cjs', target: 'node24', packages: 'external',
  tsconfig: join(root, 'tsconfig.node.json') })
const env = { ...process.env, JAVDEX_MPV_PROTOTYPE_ROOT: root }
delete env.ELECTRON_RUN_AS_NODE
// Give the verification process a distinct identity: never attach UI inspection
// or quit actions to a user's concurrently running normal Electron application.
const electronApp = resolve(dirname(require('electron')), '../..')
const probeApp = join(output, 'Javdex libmpv Probe.app')
if (!existsSync(probeApp)) {
  cpSync(electronApp, probeApp, { recursive: true, verbatimSymlinks: true })
  const plist = join(probeApp, 'Contents/Info.plist')
  const text = readFileSync(plist, 'utf8')
    .replace(/(<key>CFBundleIdentifier<\/key>\s*<string>)[^<]+/, '$1com.javdex.libmpv-prototype')
    .replace(/(<key>CFBundle(?:DisplayName|Name)<\/key>\s*<string>)[^<]+/g, '$1Javdex Playback Prototype')
  writeFileSync(plist, text)
}
const child = spawn(join(probeApp, 'Contents/MacOS/Electron'), [join(output, 'main.cjs'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
