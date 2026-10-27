// A pinned, private producer runtime; Electron 44 embeds its consumer ANGLE.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { inspectWindowsPlaybackBinary } from './playback-runtime.mjs'

const pinFile = new URL('../build/windows-angle-runtime.json', import.meta.url)
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex')
export const windowsAngleBinaries = ['libEGL.dll', 'libGLESv2.dll']
export const windowsAngleMetadata = ['windows-angle.json', 'ANGLE-LICENSE.txt']

export function verifyWindowsAngleRuntime(directory, arch) {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'))
  for (const name of [...windowsAngleBinaries, ...windowsAngleMetadata]) {
    const file = lstatSync(path.join(directory, name))
    assert.ok(file.isFile() && !file.isSymbolicLink(), 'Private ANGLE files must be regular files')
  }
  const manifest = JSON.parse(readFileSync(path.join(directory, 'windows-angle.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.arch, arch)
  assert.equal(manifest.provenanceSha256, digest(pinFile), 'Private ANGLE provenance changed; restage its runtime')
  assert.deepEqual(Object.keys(manifest.files).sort(), [...windowsAngleBinaries, 'ANGLE-LICENSE.txt'].sort())
  assert.equal(manifest.archiveSha256, pin.archives[arch]?.sha256)
  for (const [name, hash] of Object.entries(manifest.files))
    assert.equal(digest(path.join(directory, name)), hash, 'Private ANGLE digest mismatch: ' + name)
  const binaryFiles = windowsAngleBinaries.map(name => path.join(directory, name))
  for (const file of binaryFiles) inspectWindowsPlaybackBinary(file, { directory, archName: arch, binaryFiles })
  return manifest
}

export async function stageWindowsAngleRuntime(directory, arch, archive = process.env.JAVDEX_WINDOWS_ANGLE_ARCHIVE) {
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')), input = pin.archives[arch]
  assert.ok(input, 'Unsupported private Windows ANGLE architecture')
  if (!archive) {
    // Resolve Electron's own dependency, even when npm places it under the
    // Electron package instead of hoisting it into the repository root.
    const require = createRequire(import.meta.url)
    const electronRequire = createRequire(require.resolve('electron/package.json'))
    const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href)
    archive = await downloadArtifact({ version: pin.providerVersion, artifactName: 'electron', platform: 'win32', arch,
      checksums: { [input.filename]: input.sha256 } })
  }
  assert.equal(digest(archive), input.sha256, 'Private ANGLE supplier archive digest mismatch')
  mkdirSync(directory, { recursive: true }); directory = realpathSync(directory)
  const temporary = mkdtempSync(path.join(directory, '.angle-'))
  try {
    // Windows' bsdtar reads ZIP; an MSYS GNU tar earlier in PATH does not.
    const extractor = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar'
    const extraction = spawnSync(extractor, ['-xf', path.resolve(archive), '-C', temporary,
      ...windowsAngleBinaries, 'LICENSE', 'LICENSES.chromium.html'], { encoding: 'utf8' })
    assert.equal(extraction.status, 0, 'Cannot extract pinned private ANGLE: ' + extraction.stderr)
    const binaryFiles = windowsAngleBinaries.map(name => path.join(temporary, name))
    for (const file of binaryFiles) inspectWindowsPlaybackBinary(file, { directory: temporary, archName: arch, binaryFiles })
    for (const name of windowsAngleBinaries) copyFileSync(path.join(temporary, name), path.join(directory, name))
    writeFileSync(path.join(directory, 'ANGLE-LICENSE.txt'), readFileSync(path.join(temporary, 'LICENSE'), 'utf8')
      + '\n\nOriginal upstream third-party notices (HTML):\n' + readFileSync(path.join(temporary, 'LICENSES.chromium.html'), 'utf8'))
    const manifest = { schemaVersion: 1, arch, providerVersion: pin.providerVersion, angleRevision: pin.angleRevision,
      archiveSha256: input.sha256, provenanceSha256: digest(pinFile),
      files: Object.fromEntries([...windowsAngleBinaries, 'ANGLE-LICENSE.txt'].map(name => [name, digest(path.join(directory, name))])) }
    writeFileSync(path.join(directory, 'windows-angle.json'), JSON.stringify(manifest, null, 2) + '\n')
    return verifyWindowsAngleRuntime(directory, arch)
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), directory, 'Temporary extraction must stay inside its runtime directory')
    if (existsSync(temporary)) rmSync(temporary, { recursive: true })
  }
}
