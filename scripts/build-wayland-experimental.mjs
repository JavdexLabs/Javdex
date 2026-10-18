#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { experimentalRoot, EXPERIMENTAL_OUTPUT, verifyExperimentalRuntime } from './wayland-experimental-package.mjs'
import { resolveNodeGypPythonEnvironment } from './packaging-runtime.mjs'

assert.equal(process.platform, 'linux', 'Build the experimental Linux package on Linux')
assert.equal(process.arch, 'x64', 'This experimental package currently targets x86_64')
assert.ok(process.env.JAVDEX_PLAYBACK_RUNTIME_DIR, 'Set JAVDEX_PLAYBACK_RUNTIME_DIR to the complete reviewed runtime matrix')
assert.deepEqual(process.argv.slice(2).filter(arg => arg !== '--skip-build'), [], 'Only --skip-build is supported')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: experimentalRoot, stdio: 'inherit',
    env: { ...process.env, ...resolveNodeGypPythonEnvironment() } })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed`)
}
if (!process.argv.includes('--skip-build')) run('npm', ['run', 'build'])
run(process.execPath, [path.join(experimentalRoot, 'node_modules/electron-builder/cli.js'),
  '--config', 'electron-builder.wayland-experimental.config.mjs', '--linux', '--x64', '--publish', 'never'])
const output = path.join(experimentalRoot, EXPERIMENTAL_OUTPUT)
run(process.execPath, ['scripts/check-packaged-playback-runtime.mjs', output])
verifyExperimentalRuntime(path.join(output, 'linux-unpacked/resources/linux-texture-experimental'), { sourceDirectory: output })
run(process.execPath, ['scripts/check-wayland-experimental-appimage.mjs', output])
console.log('Experimental AppImage built and runtime/source inventories verified. Real Wayland GPU playback remains a separate host acceptance check.')
