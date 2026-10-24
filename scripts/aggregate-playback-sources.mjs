import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar } from 'tar'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { sha256, safePath, materialBytes } from './restore-playback-sources.mjs'
import { playbackPackagingDigest, playbackInstallers } from './playback-source-materials.mjs'
import { unpackPlaybackSources as unpack } from './playback-source-archive.mjs'
import { verifyLinuxSourceMaterials } from './linux-release-materials.mjs'

const targets = { 'win32-x64': 'windows-x64', 'darwin-x64': 'macos-x64',
  'darwin-arm64': 'macos-arm64', 'linux-x64': 'linux-x64' }
const binary = name => name === 'playback-helper' || /\.(node|dll|dylib)$|\.so(?:\.\d+)*$/.test(name)
function files(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = prefix + entry.name
    assert.ok(!entry.isSymbolicLink(), 'Source materials cannot contain links')
    if (entry.isDirectory()) return files(path.join(directory, entry.name), name + '/')
    assert.ok(entry.isFile(), 'Source materials must be regular files')
    return [name]
  })
}

// libmpv-sources.tar wraps pristine upstream archives. Split at tar entry
// boundaries, retaining headers/padding verbatim: shared upstream files dedupe
// even when tar timestamps/order differ. Restore reproduces the exact input SHA.
export function splitSourceTar(bytes, store, onFile = () => {}) {
  const parts = []
  let offset = 0
  while (offset < bytes.length) {
    assert.ok(offset + 512 <= bytes.length, 'Truncated source tar')
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) { parts.push(store(bytes.subarray(offset), 'tar-metadata')); break }
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    assert.match(sizeText, /^[0-7]+$/, 'Unsupported source tar size')
    const size = parseInt(sizeText, 8)
    const end = offset + 512 + Math.ceil(size / 512) * 512
    assert.ok(end <= bytes.length, 'Truncated source tar payload')
    const checksum = parseInt(header.subarray(148, 156).toString('ascii').trim(), 8)
    const actual = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0)
    assert.equal(checksum, actual, 'Source tar header checksum mismatch')
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (header[156] === 0 || header[156] === 48) onFile(name.replace(/^\.\//, ''), bytes.subarray(offset + 512, offset + 512 + size))
    const group = /(?:^|\/)mpv[-/]/.test(name) ? 'mpv' : /(?:^|\/)ffmpeg[-/]/.test(name) ? 'ffmpeg' : 'dependencies'
    parts.push(store(header, 'tar-metadata'))
    if (size) parts.push(store(bytes.subarray(offset + 512, offset + 512 + size), group))
    if (end > offset + 512 + size) parts.push(store(bytes.subarray(offset + 512 + size, end), 'tar-metadata'))
    offset = end
  }
  assert.equal(Buffer.concat(parts.map(p => p.bytes)).length, bytes.length)
  return parts.map(({ bytes, ...part }) => part)
}

export async function aggregatePlaybackSources(directory, version) {
  assert.match(version, /^[a-zA-Z0-9.+_-]+$/)
  const outputDirectory = path.join(directory, 'playback-sources-combined')
  const output = path.join(outputDirectory, `Javdex-Playback-Sources-${version}.tar.gz`)
  assert.ok(!fs.existsSync(outputDirectory), 'Refusing to overwrite combined source bundle')
  const archives = fs.readdirSync(directory).filter(name => /^Javdex-Playback-Sources-.*\.tar\.gz$/.test(name)).sort()
  assert.equal(archives.length, 4, 'Exactly four platform source bundles are required')
  const temporary = fs.mkdtempSync(path.join(directory, '.playback-source-aggregate-'))
  try {
    const root = path.join(temporary, 'Playback-Sources')
    fs.mkdirSync(path.join(root, 'manifests'), { recursive: true })
    const objects = new Map(), manifests = []
    const store = (bytes, group) => {
      const hash = sha256(bytes)
      let name = objects.get(hash)
      if (!name) {
        name = `${group === 'LICENSES' ? 'LICENSES' : 'sources/' + group}/${hash}`
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
        fs.writeFileSync(path.join(root, name), bytes, { flag: 'wx' })
        objects.set(hash, name)
      }
      return { path: name, sha256: hash, bytes }
    }
    for (const archive of archives) {
      const input = path.join(temporary, 'input-' + manifests.length)
      await unpack(path.join(directory, archive), input)
      const runtimeBytes = fs.readFileSync(path.join(input, 'reviewed-runtime/runtime.json'))
      const runtime = JSON.parse(runtimeBytes)
      const target = targets[`${runtime.platform}-${runtime.arch}`]
      assert.ok(target && !manifests.some(m => m.target === target), 'Duplicate/unsupported source target')
      assert.equal(runtime.schemaVersion, 1)
      assert.equal(runtime.hashStage, 'pre-sign')
      assert.ok(!runtime.sourceBundle, 'Expected complete build input, not packaged projection')
      const projection = JSON.parse(fs.readFileSync(path.join(directory, archive + '.runtime.json')))
      assert.equal(projection.schemaVersion, 1)
      assert.equal(projection.hashStage, 'pre-sign')
      const binding = projection.sourceBundle
      assert.equal(binding.fileName, archive)
      assert.equal(binding.sha256, playbackFileSha256(path.join(directory, archive)))
      assert.equal(binding.inputInventorySha256, sha256(runtimeBytes))
      for (const key of ['platform', 'arch', 'electronVersion', 'mpvVersion']) assert.equal(projection[key], runtime[key])
      assert.deepEqual(projection.components, runtime.components)
      const installerProof = JSON.parse(fs.readFileSync(path.join(directory, archive + '.installers.json')))
      assert.equal(installerProof.schemaVersion, 1)
      assert.equal(installerProof.target, target)
      assert.equal(installerProof.version, version, 'Installer verification version mismatch')
      assert.deepEqual(installerProof.sourceBundle, binding)
      assert.deepEqual(Object.keys(installerProof.installers).sort(), Object.entries(playbackInstallers(version)).filter(([, value]) => value === target).map(([name]) => name).sort(), 'Installer verification matrix mismatch')
      const projectionSha256 = playbackFileSha256(path.join(directory, archive + '.runtime.json'))
      for (const proof of Object.values(installerProof.installers)) assert.equal(proof.runtimeInventorySha256, projectionSha256, 'Final installer inventory binding mismatch')
      if (runtime.kind === 'linux-integrated') {
        assert.equal(target, 'linux-x64')
        assert.equal(runtime.version, version)
        assert.deepEqual(projection, { ...runtime, sourceBundle: binding }, 'Linux distribution inventory mismatch')
        await verifyLinuxSourceMaterials(input, projection, temporary)
        const materials = {}
        for (const name of files(input)) {
          const bytes = fs.readFileSync(path.join(input, name)), { bytes: ignored, ...record } = store(bytes, name.includes('/sources/') ? 'dependencies' : 'linux')
          materials[name] = { ...record, bytes: bytes.length, mode: fs.statSync(path.join(input, name)).mode & 0o777 }
          materialBytes(root, materials[name])
        }
        manifests.push({ schemaVersion: 1, target, version, originalBundle: binding, runtime, materials, installerProof, installers: [] })
        fs.rmSync(input, { recursive: true })
        continue
      }
      assert.ok(runtime.components.some(c => c.name === 'javdex-native' && c.version === version), 'Wrong native source version')
      for (const name of Object.keys(runtime.files).filter(binary)) assert.equal(projection.files[name], runtime.files[name], 'Runtime binary binding mismatch')
      for (const component of runtime.components) for (const field of ['licenseFile', 'sourceArchive', 'buildRecipe']) {
        const name = safePath(component[field])
        assert.ok(runtime.files[name] && fs.statSync(path.join(input, 'reviewed-runtime', name)).size > 0, 'Missing component source/build/license')
      }
      const sourceFiles = files(path.join(input, 'reviewed-runtime'))
      assert.deepEqual(sourceFiles.sort(), ['runtime.json', ...Object.keys(runtime.files).filter(n => !binary(n))].sort(), 'Incomplete/extra source materials')
      assert.equal(playbackPackagingDigest(path.join(input, 'packaging-tools')), binding.packagingToolsSha256, 'Packaging tools binding mismatch')
      assert.equal(JSON.parse(fs.readFileSync(path.join(input, 'packaging-tools/package.json'))).version, version)
      const materials = {}, preferredSources = new Map()
      for (const name of files(input)) {
        const file = path.join(input, name), bytes = fs.readFileSync(file), hash = sha256(bytes)
        if (name.startsWith('reviewed-runtime/') && name !== 'reviewed-runtime/runtime.json')
          assert.equal(hash, runtime.files[name.slice('reviewed-runtime/'.length)], 'Input source digest mismatch')
        let record
        if (name.startsWith('reviewed-runtime/sources/') && name.endsWith('.tar')) {
          record = { parts: splitSourceTar(bytes, store, (name, source) => {
            if (!preferredSources.has(name)) preferredSources.set(name, [])
            preferredSources.get(name).push({ sha256: sha256(source), bytes: source.length })
          }) }
        } else if (name.includes('/sources/') || name.includes('/licenses/')) {
          const group = name.includes('/licenses/') ? 'LICENSES' : name.includes('javdex-native') ? 'javdex-native' : 'dependencies'
          const { bytes: ignored, ...stored } = store(bytes, group)
          record = stored
        } else {
          const destination = `platforms/${target}/${name}`
          fs.mkdirSync(path.dirname(path.join(root, destination)), { recursive: true })
          fs.copyFileSync(file, path.join(root, destination))
          record = { path: destination }
        }
        materials[name] = { ...record, bytes: bytes.length, sha256: hash, mode: fs.statSync(file).mode & 0o777 }
      }
      const receipt = JSON.parse(fs.readFileSync(path.join(input, 'reviewed-runtime/build.json')))
      assert.equal(receipt.platform, runtime.platform)
      assert.equal(receipt.arch, runtime.arch)
      assert.ok(Array.isArray(receipt.sources) && receipt.sources.length > 0, 'Missing preferred source pins')
      assert.ok(receipt.sources.some(s => s.id === 'mpv' && s.version === runtime.mpvVersion), 'Mismatched mpv source pin')
      for (const source of receipt.sources) {
        safePath(source.filename)
        assert.ok(preferredSources.get(source.filename)?.some(item => item.sha256 === source.sha256 && item.bytes === source.bytes),
          'Missing/mismatched pinned upstream source: ' + source.filename)
      }
      const native = path.join(temporary, 'native-' + target)
      await unpack(path.join(input, 'reviewed-runtime/sources/javdex-native.tar.gz'), native)
      // Preserve restoration of already-distributed source archives after the
      // Windows display implementation was removed from new builds.
      const windowsEntry = fs.existsSync(path.join(native, 'apps/desktop/src/main/player/native/windowsPlaybackAddon.cpp'))
        ? 'windowsPlaybackAddon.cpp' : 'windowsPlayback.cpp'
      const requiredNative = ['package.json', 'package-lock.json', 'build/playback-sources.json', 'LICENSE', 'NOTICE',
        'scripts/build-playback-runtime.mjs', 'scripts/playback-source-build.mjs', 'scripts/playback-runtime.mjs',
        'scripts/playback-source-materials.mjs', 'scripts/packaging-runtime.mjs', 'scripts/playback-native-build.mjs',
        'scripts/check-playback-load.mjs', 'scripts/playback-linux-helper-smoke.mjs',
        'apps/desktop/src/main/player/native/CMakeLists.txt', 'apps/desktop/src/main/player/native/mpvCore.h',
        `apps/desktop/src/main/player/native/${{ win32: windowsEntry, darwin: 'macSharedTexture.mm', linux: 'linuxX11Playback.cpp' }[runtime.platform]}`,
        'electron-sdk/include/node/node.h', 'electron-sdk/include/node/node_version.h',
        ...(runtime.platform === 'win32' ? ['win_delay_load_hook.cc', 'node-gyp-LICENSE',
          'apps/desktop/src/main/player/native/windowsSharedTexture.cpp',
          'apps/desktop/src/main/player/native/windowsSoftwarePlayback.cpp',
          'apps/desktop/src/main/player/native/windowsTextureTickets.h',
          'apps/desktop/src/main/player/native/windowsTextureTickets.test.cpp'] : [])]
      // Old archives predate the shared CPU implementation. New producers must
      // carry its header; never accept a snapshot that cannot rebuild itself.
      if (['darwin', 'win32'].includes(runtime.platform)) {
        const producer = runtime.platform === 'darwin' ? 'macSharedTexture.mm' : 'windowsSoftwarePlayback.cpp'
        if (fs.readFileSync(path.join(native, 'apps/desktop/src/main/player/native', producer), 'utf8').includes('#include "softwarePlayback.h"'))
          requiredNative.push('apps/desktop/src/main/player/native/softwarePlayback.h')
      }
      if (runtime.playbackHostVersion === 1 && runtime.platform !== 'linux') requiredNative.push('apps/desktop/src/main/player/native/playbackInterop.cpp')
      // Application-local headers belong to the native source closure. SDK
      // headers have a different include root and conditional generated includes
      // (e.g. V8_GN_HEADER); validate their identity separately below instead of
      // treating their quoted includes as application files.
      const nativeDirectory = path.join(native, 'apps/desktop/src/main/player/native')
      const visited = new Set()
      function headers(file) {
        if (visited.has(file)) return
        visited.add(file)
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/^\s*#include "([^"/\\]+)"/gm)) {
          const header = path.join(nativeDirectory, match[1])
          assert.ok(fs.statSync(header).size > 0, 'Missing native header: ' + match[1])
          headers(header)
        }
      }
      for (const name of requiredNative.filter(name => name.startsWith('apps/desktop/src/main/player/native/')
        && /\.(?:h|cpp|mm)$/.test(name))) headers(path.join(native, name))
      for (const name of requiredNative) assert.ok(fs.statSync(path.join(native, name)).size > 0, 'Missing preferred native source/SDK: ' + name)
      assert.equal(JSON.parse(fs.readFileSync(path.join(native, 'package.json'))).version, version, 'Native snapshot version mismatch')
      const nativeLock = JSON.parse(fs.readFileSync(path.join(native, 'build/playback-sources.json')))
      assert.deepEqual(nativeLock.sdk, receipt.sdk, 'Native SDK lock mismatch')
      assert.equal(nativeLock.sdk.electronVersion, runtime.electronVersion)
      const nodeHeader = fs.readFileSync(path.join(native, 'electron-sdk/include/node/node_version.h'), 'utf8')
      const nodeVersion = ['MAJOR', 'MINOR', 'PATCH'].map(part => nodeHeader.match(new RegExp(`NODE_${part}_VERSION\\s+(\\d+)`))?.[1]).join('.')
      assert.equal(nodeVersion, nativeLock.sdk.nodeVersion, 'Native SDK headers mismatch')
      for (const source of receipt.sources) assert.ok(nativeLock.sources.some(s => s.id === source.id && s.version === source.version && s.sha256 === source.sha256), 'Native preferred source lock mismatch')
      fs.rmSync(native, { recursive: true })
      // Round-trip every material, including exact original nested tar bytes.
      for (const record of Object.values(materials)) materialBytes(root, record)
      const manifest = { schemaVersion: 1, target, version, originalBundle: binding, runtime,
        materials, installerProof, installers: [] }
      manifests.push(manifest)
      fs.rmSync(input, { recursive: true })
    }
    const expectedInstallers = playbackInstallers(version)
    const installers = fs.readdirSync(directory).filter(n => /\.(exe|zip|dmg|deb|AppImage)$/.test(n)).sort()
    assert.deepEqual(installers, Object.keys(expectedInstallers).sort(), 'Exactly six desktop packages are required')
    for (const name of installers) {
      const target = expectedInstallers[name]
      const manifest = manifests.find(m => m.target === target)
      const hash = playbackFileSha256(path.join(directory, name))
      assert.equal(manifest.installerProof.installers[name]?.sha256, hash, 'Final installer digest mismatch')
      manifest.installers.push({ fileName: name, sha256: hash })
    }
    for (const manifest of manifests) {
      assert.equal(manifest.installers.length, ['windows-x64', 'linux-x64'].includes(manifest.target) ? 2 : 1)
      fs.writeFileSync(path.join(root, 'manifests', manifest.target + '.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    fs.copyFileSync(new URL('./restore-playback-sources.mjs', import.meta.url), path.join(root, 'restore.mjs'))
    fs.writeFileSync(path.join(root, 'README.md'), [
      `# Playback corresponding sources — ${version}`,
      'This is not needed to install or play media. Each manifests/<platform>.json binds installers, pre-sign playback binary hashes, original platform bundle hashes and all source/build materials.',
      'sources/ and LICENSES/ are content-addressed: only identical SHA-256 contents share storage, never names. Pristine upstream archives remain intact. Uncompressed tar containers are stored as ordered header/payload parts, deduplicating shared files while preserving exact original bytes. Different versions or contents remain distinct.',
      'Restore on Node.js 22+: `node restore.mjs windows-x64 /path/to/new-directory` (also macos-x64, macos-arm64, linux-x64). All bytes are verified before restoration; an existing destination is refused. Follow the restored README.txt and build recipes with packaging-tools/. Integrated Linux restores three exact component archives for the GPU helper, CPU helper and ANGLE; extract each into a separate new directory. Other targets retain reviewed-runtime/build.json. System compilers/SDKs and platform ABIs are prerequisites; signatures and byte-identical compiler output are not promised.',
      'Original per-platform companion archives are CI-only. Input inventories and nested archives restore exactly; compressed outer archive hashes remain provenance records, not hashes of this combined archive. SHA256SUMS.txt alongside this download verifies the combined archive. Never trust a source package as an update signing root.', ''
    ].join('\n\n'))
    await createTar({ cwd: temporary, file: path.join(temporary, 'combined.tar.gz'), gzip: true, portable: true }, ['Playback-Sources'])
    const check = path.join(temporary, 'final-check')
    await unpack(path.join(temporary, 'combined.tar.gz'), check)
    for (const target of Object.values(targets)) {
      const manifest = JSON.parse(fs.readFileSync(path.join(check, 'Playback-Sources/manifests', target + '.json')))
      assert.deepEqual(manifest, manifests.find(m => m.target === target))
      for (const record of Object.values(manifest.materials)) materialBytes(path.join(check, 'Playback-Sources'), record)
    }
    // Keep platform inputs for CI diagnostics; public assets live separately.
    fs.mkdirSync(outputDirectory)
    fs.renameSync(path.join(temporary, 'combined.tar.gz'), output)
    return output
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version
  console.log(await aggregatePlaybackSources(path.resolve(process.argv[2] ?? 'release-artifacts'), version))
}
