import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { playbackNativeBuild } from './playback-native-build.mjs'

const input = { arch: 'x64', root: '/repo with spaces', prefix: '/mpv development', include: '/Electron headers',
  nodeLibrary: '/Electron x64/node.lib', delayHook: '/installed node-gyp/src/win_delay_load_hook.cc', output: '/repo with spaces/out/native-playback' }

test('macOS build executes shared-core and navigation regressions before its Cocoa adapter', () => {
  const steps = playbackNativeBuild({ ...input, platform: 'darwin' })
  assert.equal(steps.length, 5)
  assert.ok(steps[2].args.includes(path.join(input.root, 'apps/desktop/src/main/player/native/mpvCore.test.cpp')))
  assert.equal(steps[3].command, path.join(input.output, 'mpv-core-test'))
  assert.ok(steps[4].args.includes('-fobjc-arc'))
  assert.ok(steps[4].args.includes(`-I${input.include}`), 'paths remain one argument, not shell-quoted/interpreted')
  assert.ok(steps[4].args.includes('OpenGL'))
  for (const [arch, compilerArch] of [['x64', 'x86_64'], ['arm64', 'arm64']]) {
    for (const step of playbackNativeBuild({ ...input, platform: 'darwin', arch }).filter(step => step.command === 'clang++'))
      assert.equal(step.args[step.args.indexOf('-arch') + 1], compilerArch, 'compile for the running Electron architecture, not compiler defaults')
  }
})
test('Windows command plan selects installed inputs and CMake, without macOS flags', () => {
  for (const [arch, cmakeArch] of [['x64', 'x64'], ['arm64', 'ARM64']]) {
    const steps = playbackNativeBuild({ ...input, platform: 'win32', arch })
    assert.deepEqual(steps.map(step => step.command), ['cmake', 'cmake', path.join(input.output, 'mpv-core-test.exe')])
    assert.equal(steps[0].args[steps[0].args.indexOf('-A') + 1], cmakeArch)
    assert.ok(steps[0].args.includes(`-DELECTRON_NODE_LIBRARY=${input.nodeLibrary}`))
    assert.ok(steps[0].args.includes(`-DELECTRON_DELAY_LOAD_HOOK=${input.delayHook}`))
    assert.ok(steps[0].args.includes(`-DMPV_PREFIX=${input.prefix}`))
    assert.deepEqual(steps[1].args.slice(-2), ['--config', 'Release'])
    assert.ok(steps.every(step => !step.args.includes('-framework')))
  }
})
test('Windows addon installs the Electron import hook directly in its delayed-load module', () => {
  const cmake = readFileSync(new URL('../apps/desktop/src/main/player/native/CMakeLists.txt', import.meta.url), 'utf8')
  assert.ok(cmake.includes('add_library(playback MODULE windowsPlayback.cpp "${ELECTRON_DELAY_LOAD_HOOK}")'))
  assert.ok(cmake.includes('HOST_BINARY="node.exe"'))
  assert.ok(cmake.includes('target_link_options(playback PRIVATE /DELAYLOAD:node.exe)'))
  assert.match(cmake, /target_link_libraries\(playback PRIVATE "\$\{ELECTRON_NODE_LIBRARY\}" delayimp /)
})
test('Linux uses its installed X11 development inputs and runs core/control regressions', () => {
  const steps = playbackNativeBuild({ ...input, platform: 'linux' })
  assert.deepEqual(steps.map(step => step.command), ['cmake', 'cmake', path.join(input.output, 'mpv-core-test'), path.join(input.output, 'x11-controls-test')])
  assert.ok(steps[0].args.includes(`-DELECTRON_INCLUDE_DIR=${input.include}`))
  assert.ok(steps[0].args.includes(`-DMPV_PREFIX=${input.prefix}`))
  assert.ok(steps.every(step => !step.args.includes('-A') && !step.args.includes('-framework')))
})
test('unsupported backend, architecture and missing Windows linkage fail closed', () => {
  assert.throws(() => playbackNativeBuild({ ...input, platform: 'freebsd' }), /not implemented/)
  assert.throws(() => playbackNativeBuild({ ...input, platform: 'win32', arch: 'ia32' }), /architecture/)
  assert.throws(() => playbackNativeBuild({ ...input, platform: 'win32', nodeLibrary: undefined }), /node.lib/)
  assert.throws(() => playbackNativeBuild({ ...input, platform: 'win32', delayHook: undefined }), /delay-load hook/)
})
