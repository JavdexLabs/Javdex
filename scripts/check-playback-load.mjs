#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
const directory = path.resolve(process.argv[2] ?? '')
assert.ok(process.argv[2] && existsSync(directory), 'Pass the actual playback runtime directory')
const environment = { ...process.env }
for (const key of ['JAVDEX_MPV_PREFIX', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH', 'LD_LIBRARY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS']) delete environment[key]
// The loader must not be rescued by a codec prefix in PATH (especially Windows).
const pathKey = Object.keys(environment).find(key => key.toLowerCase() === 'path') ?? 'PATH'
const compilerEnvironment = { ...environment }
environment[pathKey] = process.platform === 'win32' ? `${process.env.SystemRoot}/System32` : '/usr/bin:/bin'
function run(command, args, env = environment) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Playback load/decode smoke failed: ${result.stderr}`)
  if (result.stdout.trim()) console.log(result.stdout.trim())
}
if (process.platform === 'linux') {
  run(process.execPath, [path.join(root, 'scripts/playback-linux-helper-smoke.mjs'), path.join(directory, 'playback-helper')])
} else {
  const exports = process.platform === 'win32' ? [] : ['create', 'destroy', 'state', 'setWakeup', 'nextFrame', 'releaseFrame', 'resetTiming', 'setRenderBudget', 'generatedSubtitles']
  const sharedExports = ['create', 'destroy', 'state', 'inspect', 'setBounds', 'setVisible', 'setWakeup', 'nextFrame', 'releaseFrame', 'resetTiming', 'setRenderBudget', 'requestSelfTest', 'command', 'generatedSubtitles']
  const softwareExports = ['resetTiming', 'setRenderBudget', 'create', 'destroy', 'state', 'inspect', 'setBounds', 'setVisible', 'nextFrame', 'command', 'generatedSubtitles']
  const script = `const a=require(${JSON.stringify(path.join(directory, 'playback.node'))});for(const k of ${JSON.stringify(exports)})if(typeof a[k]!=='function')throw Error('Missing native export '+k);for(const k of ${JSON.stringify(softwareExports)})if(typeof a.software?.[k]!=='function')throw Error('Missing CPU export '+k);if(process.platform==='win32'){for(const k of ['create','render','capture','setPresentation'])if(a[k]!==undefined)throw Error('Obsolete Windows HWND export '+k);for(const k of ${JSON.stringify(sharedExports)})if(typeof a.sharedTexture?.[k]!=='function')throw Error('Missing Windows shared export '+k)}const i=require(${JSON.stringify(path.join(directory, 'playback-interop.node'))});for(const k of (process.platform==='win32'?['acquire','release']:['createChannel','closeChannel','acquireSurface','publishSurface','release']))if(typeof i[k]!=='function')throw Error('Missing playback interop export '+k);console.log('Playback addon loaded in Electron '+process.versions.electron)`
  run(require('electron'), ['-e', script], { ...environment, ELECTRON_RUN_AS_NODE: '1' })
}
const matrix = path.resolve(process.env.JAVDEX_PLAYBACK_RUNTIME_DIR ?? path.join(root, 'out/playback-runtime'))
const headers = existsSync(path.join(directory, 'sources/mpv/client.h')) ? path.join(directory, 'sources') :
  path.join(matrix, `${process.platform}-${process.arch}`, 'sources')
assert.ok(existsSync(path.join(headers, 'mpv/client.h')), 'Missing source-built libmpv smoke headers')
const scratchRoot = path.join(root, 'out/playback-runtime-build'); mkdirSync(scratchRoot, { recursive: true })
const scratch = mkdtempSync(path.join(scratchRoot, 'decode-')), program = path.join(scratch, process.platform === 'win32' ? 'decode.exe' : 'decode')
const source = path.join(root, 'apps/desktop/src/main/player/native/runtimeDecode.test.cpp')
if (process.platform === 'win32') run('cl.exe', ['/nologo', '/std:c++17', '/EHsc', '/MT', `/I${headers}`, source, `/Fe:${program}`, `/Fo:${path.join(scratch, 'decode.obj')}`], compilerEnvironment)
else run(process.platform === 'darwin' ? 'clang++' : 'c++', ['-std=c++17', `-I${headers}`, source, ...(process.platform === 'linux' ? ['-ldl'] : []), '-o', program], compilerEnvironment)
const library = readdirSync(directory).find(file => process.platform === 'darwin' ? /^libmpv\.\d+\.dylib$/.test(file) :
  process.platform === 'win32' ? /^(lib)?mpv.*\.dll$/.test(file) : /^libmpv\.so\.\d+$/.test(file))
assert.ok(library, 'Missing relocated libmpv')
run(program, [path.join(directory, library), path.join(scratch, 'smoke.wav')])
console.log('Playback loader and PCM decode passed without development library paths; GUI/GL, hardware decoding and codec matrix are separate acceptance.')
