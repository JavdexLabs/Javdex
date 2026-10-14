// Actual package boundary acceptance, on native ephemeral CI runners only.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findPackagedResources, verifyPackagedPlaybackResources } from './check-packaged-playback-runtime.mjs'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { playbackInstallers } from './playback-source-materials.mjs'

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 ** 2 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Installer extraction failed: ' + result.stderr)
  return result.stdout
}
function extractInstaller(file, destination) {
  assert.equal(process.env.CI, 'true', 'Installer execution is restricted to ephemeral CI runners')
  const mount = path.join(destination, 'mounted')
  if (file.endsWith('.dmg')) {
    fs.mkdirSync(mount)
    run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, file])
    return { root: mount, cleanup: () => run('hdiutil', ['detach', mount]) }
  }
  if (file.endsWith('.zip')) run('tar', ['-xf', file, '-C', destination])
  else if (file.endsWith('.exe')) run(file, ['/S', `/D=${path.join(destination, 'installed')}`])
  else if (file.endsWith('.deb')) run('dpkg-deb', ['--extract', file, destination])
  else if (file.endsWith('.AppImage')) run(file, ['--appimage-extract'], destination)
  else throw new Error('Unsupported playback installer')
  return { root: destination, cleanup: () => {} }
}
export function verifyPlaybackInstallers(output, version, target, {
  extract = extractInstaller, verify = verifyPackagedPlaybackResources
} = {}) {
  const names = Object.entries(playbackInstallers(version)).filter(([, value]) => value === target).map(([name]) => name)
  assert.ok(names.length)
  const originalResources = findPackagedResources(output)
  assert.equal(originalResources.length, 1, 'Expected one verified unpacked application')
  const originalRuntime = path.join(originalResources[0], 'native-playback')
  const originalInventory = playbackFileSha256(path.join(originalRuntime, 'runtime.json'))
  const receipts = new Map()
  for (const name of names) {
    const artifact = path.join(output, name)
    assert.ok(fs.lstatSync(artifact).isFile() && !fs.lstatSync(artifact).isSymbolicLink(), 'Missing installer')
    const sha256 = playbackFileSha256(artifact)
    const temporary = fs.mkdtempSync(path.join(output, '.playback-installer-'))
    let extracted
    try {
      extracted = extract(artifact, temporary)
      const resources = findPackagedResources(extracted.root)
      assert.equal(resources.length, 1, 'Installer must contain exactly one application')
      const manifest = JSON.parse(fs.readFileSync(path.join(resources[0], 'native-playback/runtime.json')))
      assert.equal(playbackFileSha256(path.join(resources[0], 'native-playback/runtime.json')), originalInventory,
        'Installer inventory differs from verified unpacked application')
      for (const name of Object.keys(manifest.files)) assert.equal(
        playbackFileSha256(path.join(resources[0], 'native-playback', name)), playbackFileSha256(path.join(originalRuntime, name)),
        'Installer runtime differs from verified unpacked application: ' + name)
      assert.equal(`${manifest.platform}-${manifest.arch}`, `${process.platform}-${process.arch}`, 'Installer inspection requires native runner')
      const runtime = verify(resources[0], output, { platformName: manifest.platform, archName: manifest.arch, electronVersion: manifest.electronVersion })
      assert.equal(playbackFileSha256(artifact), sha256, 'Installer changed during inspection')
      const binding = runtime.manifest.sourceBundle
      assert.equal(binding.inputInventorySha256, manifest.sourceBundle.inputInventorySha256)
      const receipt = receipts.get(binding.fileName) ?? { schemaVersion: 1, target, version, sourceBundle: binding, installers: {} }
      assert.deepEqual(receipt.sourceBundle, binding)
      receipt.installers[name] = { sha256, runtimeInventorySha256: playbackFileSha256(path.join(resources[0], 'native-playback/runtime.json')) }
      receipts.set(binding.fileName, receipt)
      console.log(`Installer playback verified: ${name}, source ${binding.inputInventorySha256}`)
    } finally {
      try { extracted?.cleanup() } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
    }
  }
  assert.equal(receipts.size, 1, 'Platform installers must share one reviewed source binding')
  for (const [name, receipt] of receipts) fs.writeFileSync(path.join(output, name + '.installers.json'), JSON.stringify(receipt, null, 2) + '\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform]
  verifyPlaybackInstallers(path.resolve(process.argv[2] ?? 'dist'), version, `${platform}-${process.arch}`)
}
