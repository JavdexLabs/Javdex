// Release binding for the integrated Linux package. Legacy platform inventories
// stay unchanged; this inventory owns both helper closures and the ANGLE pair.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { playbackFileSha256 } from './playback-runtime.mjs'
import { playbackPackagingFiles, playbackPackagingDigest } from './playback-source-materials.mjs'
import { safePath } from './restore-playback-sources.mjs'
import { unpackPlaybackSources, angleSourceLimits } from './playback-source-archive.mjs'

export const linuxReleaseInventory = 'linux-playback-release.json'
export const linuxReleaseComponents = {
  gpu: { directory: 'resources/linux-texture-experimental', manifest: 'portable-runtime.json', profile: 'linux-x64-dmabuf-pulse' },
  cpu: { directory: 'resources/linux-software-playback', manifest: 'portable-runtime.json', profile: 'linux-x64-software-pulse' },
  angle: { directory: '', manifest: 'javdex-angle.json' }
}
export function linuxPackagingFiles(root) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'build/angle-runtime.json')))
  return [...new Set([...playbackPackagingFiles,
    'scripts/linux-release-materials.mjs', 'scripts/playback-source-archive.mjs', 'scripts/restore-playback-sources.mjs',
    'scripts/linux-integrated-playback.mjs', 'scripts/linux-portable-runtime.mjs', 'scripts/linux-angle-runtime.mjs',
    'scripts/linux-appimage-runtime.mjs', 'scripts/build-linux-angle.py', 'scripts/build-playback-runtime.mjs',
    'scripts/check-linux-release-playback.mjs', 'scripts/check-packaged-playback-runtime.mjs',
    'scripts/check-playback-installers.mjs', 'scripts/aggregate-playback-sources.mjs', '.github/workflows/release.yml',
    'scripts/playback-source-build.mjs', 'scripts/playback-native-build.mjs', 'scripts/patch-sharp-electron.mjs',
    'scripts/local-playback-package.mjs', 'build/linux-AppRun.sh', 'build/linux-appimage-runtime.json',
    'build/playback-sources.json', 'build/angle-runtime.json', 'build/angle-args.gn',
    'build/patches/angle-x11-vulkan-visual.patch',
    ...Object.keys(lock.electronPatches).map(name => 'build/angle-electron-patches/' + safePath(name)),
    ...['mpvCore.h', 'generatedSubtitles.h', 'linuxDmaBuf.h', 'linuxDmaBuf.test.cpp', 'frameTiming.h', 'renderConfig.h', 'colorPipeline.h', 'linuxFrameTiming.test.cpp', 'linuxVulkanModifiers.h', 'linuxFdTransport.h', 'linuxFdBridge.cpp',
      'linuxDmaBufPlayback.cpp', 'linuxSoftwarePlayback.cpp', 'runtimeDecode.test.cpp'].map(name => 'apps/desktop/src/main/player/native/' + name)
  ])]
}
export function linuxSourceBinding(output, manifest) {
  const file = path.join(output, safePath(manifest.sourceBundle.fileName))
  assert.equal(path.basename(file), manifest.sourceBundle.fileName, 'Linux source archive must be a sibling')
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'Linux source archive must be a regular file')
  assert.equal(playbackFileSha256(file), manifest.sourceBundle.sha256, 'Linux corresponding source mismatch')
}
export function linuxInventory(resources) {
  return path.join(resources, linuxReleaseInventory)
}
export function validateLinuxInventory(manifest) {
  assert.equal(manifest.kind, 'linux-integrated')
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.hashStage, 'pre-sign')
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x64')
  assert.deepEqual(Object.keys(manifest.inventories).sort(), Object.keys(linuxReleaseComponents).sort())
  for (const [id, component] of Object.entries(linuxReleaseComponents)) {
    const inventory = manifest.inventories[id]
    assert.equal(inventory.electronVersion, manifest.electronVersion)
    assert.equal(manifest.sources[id].sha256, inventory.sourceBundle.sha256, 'Linux component source binding mismatch')
    if (component.profile) assert.equal(inventory.profile, component.profile)
    const prefix = component.directory ? component.directory + '/' : ''
    for (const [name, hash] of Object.entries(inventory.files)) {
      safePath(name)
      assert.equal(manifest.files[prefix + name], hash, 'Linux component file binding mismatch')
    }
    assert.ok(manifest.files[prefix + component.manifest], 'Missing Linux component inventory')
    assert.match(manifest.sources[id].sha256, /^[a-f0-9]{64}$/)
    assert.equal(manifest.sources[id].file, 'sources/' + id + '.tar.gz')
  }
  for (const [name, hash] of Object.entries(manifest.files)) {
    safePath(name); assert.match(hash, /^[a-f0-9]{64}$/)
  }
  const expected = ['AppRun', 'resources/appimage-runtime.json', 'resources/SOURCE-ACCESS.txt']
  for (const [id, component] of Object.entries(linuxReleaseComponents)) {
    const prefix = component.directory ? component.directory + '/' : ''
    expected.push(...[...Object.keys(manifest.inventories[id].files), component.manifest, ...(id === 'angle' ? ['ANGLE-LICENSE.txt'] : [])].map(n => prefix + n))
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), expected.sort(), 'Incomplete/extra Linux release inventory')
}
export function createLinuxSourceBundle(app, output, root, inventories, sources, version) {
  assert.match(version, /^[a-zA-Z0-9.+_-]+$/)
  const relativeOutput = path.relative(path.resolve(app), path.resolve(output))
  assert.ok(relativeOutput === '..' || relativeOutput.startsWith('..' + path.sep) || path.isAbsolute(relativeOutput), 'Linux source bundle must stay outside the application')
  fs.writeFileSync(path.join(app, 'resources/SOURCE-ACCESS.txt'), `Corresponding playback source: Javdex-Playback-Sources-${version}.tar.gz\nRestore linux-x64 with restore.mjs; see reviewed-runtime/runtime.json and README.txt. Keep corresponding source materials available with any binary distribution.\n`)
  const files = {}
  for (const [id, component] of Object.entries(linuxReleaseComponents)) {
    const prefix = component.directory ? component.directory + '/' : ''
    for (const name of [...Object.keys(inventories[id].files), component.manifest,
      ...(id === 'angle' ? ['ANGLE-LICENSE.txt'] : [])]) {
      files[prefix + name] = playbackFileSha256(path.join(app, prefix, name))
    }
  }
  for (const name of ['AppRun', 'resources/appimage-runtime.json', 'resources/SOURCE-ACCESS.txt']) files[name] = playbackFileSha256(path.join(app, name))
  const manifest = { kind: 'linux-integrated', schemaVersion: 1, hashStage: 'pre-sign', platform: 'linux', arch: 'x64', version,
    electronVersion: inventories.gpu.electronVersion, inventories, files,
    sources: Object.fromEntries(Object.entries(sources).map(([id, file]) => [id, { file: 'sources/' + id + '.tar.gz', sha256: playbackFileSha256(file) }])) }
  validateLinuxInventory(manifest)
  fs.mkdirSync(output, { recursive: true })
  const names = linuxPackagingFiles(root), tools = playbackPackagingDigest(root, names)
  const temporary = fs.mkdtempSync(path.join(output, '.linux-release-sources-'))
  try {
    const payload = path.join(temporary, 'payload')
    const write = (name, bytes) => { fs.mkdirSync(path.dirname(path.join(payload, name)), { recursive: true }); fs.writeFileSync(path.join(payload, name), bytes) }
    write('reviewed-runtime/runtime.json', JSON.stringify(manifest, null, 2) + '\n')
    const inputInventorySha256 = playbackFileSha256(path.join(payload, 'reviewed-runtime/runtime.json'))
    const fileName = `Javdex-Playback-Sources-${version}-linux-x64-${inputInventorySha256.slice(0, 12)}-${tools.slice(0, 8)}.tar.gz`
    for (const [id, file] of Object.entries(sources)) write('reviewed-runtime/' + manifest.sources[id].file, fs.readFileSync(file))
    for (const name of names) write('packaging-tools/' + name, fs.readFileSync(path.join(root, name)))
    write('README.txt', 'Linux integrated playback corresponding sources\n\nreviewed-runtime/runtime.json binds both helper runtimes and the ANGLE pair. sources/gpu.tar.gz and cpu.tar.gz retain pinned upstream archives, exact Ubuntu source packages, the application recipe and Electron SDK headers. angle.tar.gz retains the ANGLE/dependency checkout and pinned patches. Restore the component archives to separate new directories; use their recipes on Ubuntu 22.04. Build both playback profiles and ANGLE before packaging. These materials do not establish GPU or GUI acceptance.\n')
    const archive = path.join(output, fileName)
    if (fs.existsSync(archive)) {
      const previous = JSON.parse(fs.readFileSync(archive + '.json'))
      assert.equal(previous.fileName, fileName)
      assert.equal(previous.inputInventorySha256, inputInventorySha256); assert.equal(previous.packagingToolsSha256, tools)
      assert.equal(previous.sha256, playbackFileSha256(archive))
      manifest.sourceBundle = previous
    } else {
      const result = spawnSync('tar', ['-czf', path.join(temporary, 'sources.tar.gz'), '-C', payload, '.'], { encoding: 'utf8', timeout: 300000 })
      if (result.error) throw result.error
      assert.equal(result.status, 0, result.stderr)
      fs.renameSync(path.join(temporary, 'sources.tar.gz'), archive)
      manifest.sourceBundle = { fileName, sha256: playbackFileSha256(archive), inputInventorySha256, packagingToolsSha256: tools }
      fs.writeFileSync(archive + '.json', JSON.stringify(manifest.sourceBundle, null, 2) + '\n')
    }
    fs.writeFileSync(path.join(app, 'resources', linuxReleaseInventory), JSON.stringify(manifest, null, 2) + '\n')
    fs.writeFileSync(archive + '.runtime.json', JSON.stringify(manifest, null, 2) + '\n')
    return manifest
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

// Executed again by the Linux packaging job and by the source aggregator. Outer
// archive hashes alone cannot prove that native code/SDK/upstream pins are present.
export async function verifyLinuxSourceMaterials(input, manifest, temporary) {
  validateLinuxInventory(manifest)
  const tools = path.join(input, 'packaging-tools')
  const lock = JSON.parse(fs.readFileSync(path.join(tools, 'build/playback-sources.json')))
  assert.equal(lock.sdk.electronVersion, manifest.electronVersion)
  assert.equal(playbackPackagingDigest(tools, linuxPackagingFiles(tools)), manifest.sourceBundle.packagingToolsSha256)
  for (const [id, source] of Object.entries(manifest.sources)) {
    const archive = path.join(input, 'reviewed-runtime', source.file)
    assert.equal(playbackFileSha256(archive), source.sha256, 'Linux source material digest mismatch')
    const extracted = path.join(temporary, id)
    await unpackPlaybackSources(archive, extracted, id === 'angle' ? angleSourceLimits : undefined)
    if (id === 'angle') {
      const angleLock = JSON.parse(fs.readFileSync(path.join(tools, 'build/angle-runtime.json')))
      assert.equal(manifest.inventories.angle.angleRevision, angleLock.angleRevision)
      for (const [field, file] of [['patchSha256', 'build/patches/angle-x11-vulkan-visual.patch'], ['argsSha256', 'build/angle-args.gn'], ['provenanceSha256', 'build/angle-runtime.json']])
        assert.equal(manifest.inventories.angle[field], playbackFileSha256(path.join(tools, file)), 'ANGLE source pin mismatch')
      for (const name of ['build/angle-runtime.json', 'build/angle-args.gn', 'scripts/build-linux-angle.py',
        'build/patches/angle-x11-vulkan-visual.patch', ...Object.keys(angleLock.electronPatches).map(n => 'build/angle-electron-patches/' + n)])
        assert.equal(playbackFileSha256(path.join(extracted, 'recipe', name)), playbackFileSha256(path.join(tools, name)), 'ANGLE recipe/source mismatch')
      for (const name of ['angle/LICENSE', 'angle/DEPS', 'angle/include/EGL/egl.h', 'angle/src/libANGLE/renderer/vulkan/linux/xcb/DisplayVkXcb.cpp'])
        assert.ok(fs.statSync(path.join(extracted, name)).size > 0, 'Missing preferred ANGLE source')
      assert.equal(playbackFileSha256(path.join(extracted, 'angle/LICENSE')), manifest.files['ANGLE-LICENSE.txt'], 'ANGLE license binding mismatch')
    } else {
      const inventory = manifest.inventories[id]
      for (const [name, hash] of Object.entries(inventory.files)) assert.equal(playbackFileSha256(path.join(extracted, 'runtime', safePath(name))), hash, 'Linux source/runtime binding mismatch')
      const receipt = JSON.parse(fs.readFileSync(path.join(extracted, 'runtime/build.json')))
      assert.deepEqual(receipt.sdk, lock.sdk)
      assert.equal(receipt.profile, inventory.profile)
      // CPU builds disable NVDEC/CUDA. Older CPU receipts predate this GPU-only
      // pin; newer builders may still deliver it as unused corresponding source.
      const expectedSources = lock.sources.filter(s => (!s.platforms || s.platforms.includes('linux'))
        && !(id === 'cpu' && s.id === 'nv_codec_headers' && !receipt.sources.some(r => r.id === s.id)))
      assert.deepEqual(receipt.sources.map(s => s.id).sort(), expectedSources.map(s => s.id).sort(), 'Incomplete Linux source pins')
      for (const source of receipt.sources) {
        assert.ok(lock.sources.some(s => s.id === source.id && s.sha256 === source.sha256 && s.version === source.version), 'Linux source pin mismatch')
        const file = path.join(extracted, safePath(source.filename))
        assert.equal(fs.statSync(file).size, source.bytes); assert.equal(playbackFileSha256(file), source.sha256, 'Missing pinned Linux source')
      }
      assert.ok(receipt.sources.some(s => s.id === 'mpv') && receipt.sources.some(s => s.id === 'ffmpeg'), 'Missing Linux codec sources')
      assert.ok(Object.keys(receipt.sourcePackages).length > 0, 'Missing Ubuntu source package inventory')
      for (const [name, version] of Object.entries(receipt.sourcePackages)) {
        const dsc = fs.readdirSync(extracted).filter(n => n.endsWith('.dsc')).map(n => fs.readFileSync(path.join(extracted, n), 'utf8'))
          .find(text => text.includes(`\nSource: ${name}\n`) && text.includes(`\nVersion: ${version}\n`))
        assert.ok(dsc, 'Missing Ubuntu corresponding source: ' + name)
        const hashes = dsc.match(/\nChecksums-Sha256:\n((?: [^\n]+\n)+)/)?.[1]
        assert.ok(hashes, 'Missing Ubuntu source checksums')
        for (const row of hashes.trim().split('\n')) {
          const [hash, size, name] = row.trim().split(/\s+/), file = path.join(extracted, safePath(name))
          assert.equal(fs.statSync(file).size, Number(size)); assert.equal(playbackFileSha256(file), hash)
        }
      }
      const recipe = path.join(extracted, 'recipe')
      const sourceFiles = JSON.parse(fs.readFileSync(path.join(recipe, '.javdex-source-files.json')))
      assert.ok(Array.isArray(sourceFiles) && sourceFiles.length > 0 && sourceFiles.length <= 50000, 'Missing Linux application source list')
      for (const name of sourceFiles) {
        safePath(name)
        assert.ok(!name.split('/').some(p => ['node_modules', '.git', 'out', 'dist'].includes(p)), 'Generated files in preferred source recipe')
        assert.ok(fs.statSync(path.join(recipe, name)).isFile(), 'Missing preferred application source')
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(recipe, 'package.json'))).version, manifest.version)
      for (const name of linuxPackagingFiles(tools)) {
        assert.ok(sourceFiles.includes(name), 'Missing Linux source-list member: ' + name)
        assert.equal(playbackFileSha256(path.join(recipe, name)), playbackFileSha256(path.join(tools, name)), 'Stale Linux recipe/source: ' + name)
      }
      const header = fs.readFileSync(path.join(extracted, 'electron-sdk/include/node/node_version.h'), 'utf8')
      assert.equal(['MAJOR', 'MINOR', 'PATCH'].map(p => header.match(new RegExp(`NODE_${p}_VERSION\\s+(\\d+)`))?.[1]).join('.'), lock.sdk.nodeVersion, 'Linux native SDK mismatch')
      assert.ok(fs.statSync(path.join(extracted, 'electron-sdk/include/node/node.h')).size > 0)
    }
    fs.rmSync(extracted, { recursive: true })
  }
}

export async function verifyLinuxSourceBundle(output, manifest) {
  linuxSourceBinding(output, manifest)
  const temporary = fs.mkdtempSync(path.join(output, '.linux-source-check-'))
  try {
    const input = path.join(temporary, 'input')
    await unpackPlaybackSources(path.join(output, manifest.sourceBundle.fileName), input)
    const file = path.join(input, 'reviewed-runtime/runtime.json')
    assert.equal(playbackFileSha256(file), manifest.sourceBundle.inputInventorySha256)
    assert.deepEqual({ ...JSON.parse(fs.readFileSync(file)), sourceBundle: manifest.sourceBundle }, manifest)
    await verifyLinuxSourceMaterials(input, manifest, temporary)
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}
