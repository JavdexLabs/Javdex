#!/usr/bin/env node
// Inspect the actual installer, not only electron-builder's unpacked directory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { extractFile } from '@electron/asar'
import { EXPERIMENTAL_VERSION, experimentalRoot, verifyExperimentalRuntime } from './wayland-experimental-package.mjs'
import { verifyPackagedPlaybackResources } from './check-packaged-playback-runtime.mjs'

const output = path.resolve(process.argv[2] ?? path.join(experimentalRoot, 'dist/wayland-experimental'))
const files = fs.readdirSync(output).filter(name => name.endsWith('.AppImage'))
assert.equal(files.length, 1, 'Expected exactly one experimental AppImage')
const artifact = path.join(output, files[0]), scratch = fs.mkdtempSync(path.join(output, '.inspect-appimage-'))
try {
  const result = spawnSync(artifact, ['--appimage-extract'], { cwd: scratch, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `AppImage extraction failed: ${result.stderr}`)
  const app = path.join(scratch, 'squashfs-root'), resources = path.join(app, 'resources')
  assert.equal(fs.readFileSync(path.join(app, 'AppRun'), 'utf8'), fs.readFileSync(path.join(experimentalRoot, 'build/linux-texture-AppRun.sh'), 'utf8'), 'Actual AppImage must preserve the sandbox launcher')
  const desktopNames = fs.readdirSync(app).filter(name => name.endsWith('.desktop'))
  assert.equal(desktopNames.length, 1)
  const desktop = fs.readFileSync(path.join(app, desktopNames[0]), 'utf8')
  assert.ok(!desktop.includes('--no-sandbox'), 'AppImage desktop entry must not disable sandboxing')
  const metadata = JSON.parse(extractFile(path.join(resources, 'app.asar'), 'package.json').toString('utf8'))
  assert.equal(metadata.javdexExperimentalLinux, true)
  assert.equal(metadata.version, EXPERIMENTAL_VERSION)
  assert.equal(metadata.name, 'javdex-linux-texture-experimental')
  const reviewed = verifyPackagedPlaybackResources(resources, output, { platformName: 'linux', archName: 'x64', electronVersion: '43.8.0' })
  const experimental = verifyExperimentalRuntime(path.join(resources, 'linux-texture-experimental'), { sourceDirectory: output })
  assert.equal(experimental.reviewedLibmpvSha256, reviewed.manifest.files['libmpv.so.2'])
  for (const name of Object.keys(experimental.files)) {
    assert.deepEqual(fs.readFileSync(path.join(resources, 'linux-texture-experimental', name)),
      fs.readFileSync(path.join(output, 'linux-unpacked/resources/linux-texture-experimental', name)), `Actual AppImage differs: ${name}`)
  }
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1',
    FD_BRIDGE_ADDON: path.join(resources, 'linux-texture-experimental/playback-fd.node'),
    FD_BRIDGE_FIXTURE: path.join(experimentalRoot, 'out/native-playback/fd-transport-fixture') }
  for (const key of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'JAVDEX_MPV_PREFIX', 'NODE_OPTIONS']) delete environment[key]
  for (const [command, args] of [
    [path.join(app, 'javdex-linux-texture-experimental'), [path.join(experimentalRoot, 'scripts/linux-fd-transport.test.cjs')]],
    [path.join(experimentalRoot, 'out/native-playback/linux-dmabuf-test'), [path.join(resources, 'linux-texture-experimental/playback-dmabuf-helper')]]
  ]) {
    const smoke = spawnSync(command, args, { env: environment, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
    if (smoke.error) throw smoke.error
    assert.equal(smoke.status, 0, `Actual AppImage runtime smoke failed: ${smoke.stdout} ${smoke.stderr}`)
    console.log(smoke.stdout.trim())
  }
  const receipt = { fileName: files[0], bytes: fs.statSync(artifact).size,
    sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex'),
    version: metadata.version, experimental: true, sandboxLauncherVerified: true,
    packagedElectronFdTransport: 'passed', packagedHelperRejectionTests: 'passed',
    reviewedSource: reviewed.manifest.sourceBundle, experimentalSource: experimental.sourceBundle,
    elf: experimental.elf, gpuAcceptance: 'Not run: build host has no DRM render node.' }
  fs.writeFileSync(path.join(output, 'experimental-appimage-verification.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
} finally { fs.rmSync(scratch, { recursive: true, force: true }) }
