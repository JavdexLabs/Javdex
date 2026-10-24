import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { aiRuntimeAssets, aiRuntimeTargetSupported, LOCAL_MODEL_ASSETS } from './runtimeManifest'
import { createAiRuntimeInstaller, aiRuntimeHostSupported } from './runtimeInstaller'
import { localModelAssets, DEFAULT_LOCAL_MODEL_VARIANTS } from './modelCatalog'
import { modelDownloadFile, runtimeAssetDirectory } from './modelStorage'
import { gpuRuntimeAssets } from './gpuManifest'
import pins from './runtimeDistributions.json'

test('mirrored POSIX CPU archives retain the existing partial-download path', () => {
  for (const platform of ['darwin', 'linux']) for (const arch of ['arm64', 'x64']) {
    for (const id of ['whisper', 'translator']) {
      const asset = aiRuntimeAssets({ platform, arch }).find(entry => entry.id === id)!
      assert.equal(modelDownloadFile('models', asset), modelDownloadFile('models', { ...asset, filename: `${id}.tar.gz` }))
    }
  }
})

test('all supported targets share portable weights but never reuse another target executable', () => {
  const weights = LOCAL_MODEL_ASSETS.filter(asset => !asset.archive)
  const runtimeHashes = new Set<string>()
  for (const target of [
    { platform: 'win32', arch: 'x64' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'arm64' }, { platform: 'linux', arch: 'x64' }
  ]) {
    assert.equal(aiRuntimeTargetSupported(target), true)
    const assets = aiRuntimeAssets(target)
    assert.deepEqual(assets.filter(asset => !asset.archive), weights)
    for (const asset of assets.filter(asset => asset.archive)) {
      assert.match(asset.sha256, /^[a-f0-9]{64}$/)
      assert.ok(asset.bytes > 0 && !runtimeHashes.has(asset.sha256))
      runtimeHashes.add(asset.sha256)
      assert.match(asset.url, /^https:\/\/github\.com\/JavdexLabs\/javdex-runtime\/releases\/download\//)
    }
    const paths = createAiRuntimeInstaller('/models', undefined, assets, { target }).paths()
    assert.equal(paths.translator.endsWith('.exe'), target.platform === 'win32')
    if (target.platform !== 'win32') assert.ok(paths.translator.includes(`${target.platform}-${target.arch}`))
    for (const family of ['qwen3', 'hy-mt2-7b'] as const) {
      const selected = localModelAssets(DEFAULT_LOCAL_MODEL_VARIANTS, family, target)
      assert.equal(selected.find(asset => asset.id === 'translation-model')!.translationModelId, family)
      assert.deepEqual(selected.filter(asset => asset.archive), assets.filter(asset => asset.archive))
    }
  }
})
test('unsupported targets enumerate only portable weights and keep the Windows storage contract', () => {
  for (const target of [{ platform: 'win32', arch: 'arm64' }, { platform: 'linux', arch: 'ia32' }, { platform: 'freebsd', arch: 'x64' }]) {
    assert.equal(aiRuntimeTargetSupported(target), false)
    assert.equal(aiRuntimeAssets(target).some(asset => asset.archive), false)
  }
  assert.equal(aiRuntimeAssets({ platform: 'win32', arch: 'x64' }), LOCAL_MODEL_ASSETS)
  const paths = createAiRuntimeInstaller('/models', undefined, undefined, { target: { platform: 'win32', arch: 'x64' } }).paths()
  assert.ok(paths.translator.endsWith('win32-x64-cpu/llama-server.exe') || paths.translator.endsWith('win32-x64-cpu\\llama-server.exe'))
})
test('host checks reject old macOS, old glibc and musl before enabling inference', () => {
  const mac = { platform: 'darwin', arch: 'arm64' }, linux = { platform: 'linux', arch: 'x64' }
  assert.equal(aiRuntimeHostSupported(mac, '22.3.0'), false)
  assert.equal(aiRuntimeHostSupported(mac, '22.4.0'), true)
  assert.equal(aiRuntimeHostSupported(mac, '25.0.0'), true)
  assert.equal(aiRuntimeHostSupported(linux, '2.36'), false)
  assert.equal(aiRuntimeHostSupported(linux, '2.38'), true)
  assert.equal(aiRuntimeHostSupported(linux, '2.39'), true)
  assert.equal(aiRuntimeHostSupported(linux, null), false)
})

test('all AI tools and GPU dependencies pin Javdex Runtime releases', () => {
  const targets = [{ platform: 'win32', arch: 'x64' }, { platform: 'linux', arch: 'x64' }, { platform: 'linux', arch: 'arm64' }, { platform: 'darwin', arch: 'arm64' }, { platform: 'darwin', arch: 'x64' }]
  for (const target of targets) {
    const base = aiRuntimeAssets(target)
    for (const id of ['whisper', 'translator', 'ffmpeg']) assert.ok(base.some(asset => asset.id === id && asset.archive))
    const tools = [...base.filter(asset => asset.archive || asset.id === 'vad'), ...gpuRuntimeAssets(target, 'cuda'), ...gpuRuntimeAssets(target, 'vulkan')]
    for (const asset of tools) {
      assert.match(asset.url, /^https:\/\/github\.com\/JavdexLabs\/javdex-runtime\/releases\/download\//)
      if (asset.runtimePackage) continue // Existing Vulkan r1 has its own manifest/provenance contract.
      const pin = pins.assets.find(entry => entry.url === asset.url)
      assert.ok(pin); assert.equal(pin.sha256, asset.sha256); assert.equal(pin.bytes, asset.bytes)
      assert.equal(pin.url, `https://github.com/JavdexLabs/javdex-runtime/releases/download/${pin.release}/${pin.name}`)
      assert.ok(pin.target === 'portable' || pin.target === `${target.platform}-${target.arch}`)
      if (asset.archive && target.platform !== 'win32') assert.equal(asset.archivePrefix, pin.archivePrefix)
    }
    const ffmpeg = base.find(asset => asset.id === 'ffmpeg')!
    const storage = runtimeAssetDirectory('store', 'ffmpeg', target)
    assert.equal(path.basename(path.dirname(storage)), '8.1.3-r1')
    assert.ok(ffmpeg.url.includes('/ffmpeg-8.1.3-r1/'))
  }
})

test('Linux llama GPU mirrors preserve upstream archive and download cache identities', () => {
  const target = { platform: 'linux', arch: 'x64' }
  const expected = [
    { id: 'translator', backend: 'vulkan', name: 'llama-b11435-bin-ubuntu-vulkan-x64.tar.gz', bytes: 31636156,
      sha256: 'e8a9c44c8212c5e7ff1186864080ae49283131c60e7c07753a296faccd3a0324', prefix: 'llama-b11435' },
    { id: 'translator', backend: 'cuda', name: 'llama-b11435-bin-ubuntu-cuda-12.8-x64.tar.gz', bytes: 171652084,
      sha256: '251ad225b60da6eab0591567b639dda5e405662589bdaee7bd54a159b8d87fa9', prefix: 'llama-b11435' },
    { id: 'cuda', backend: 'cuda', name: 'cudart-llama-b11435-bin-ubuntu-cuda-12.8-x64.tar.gz', bytes: 594377810,
      sha256: 'c14f9b18c0e19623d2fb763e47ca6cd0e409206d462176af8ac0665331b64f74', prefix: 'cudart-llama-b11435-bin-ubuntu-cuda-12.8-x64' }
  ] as const
  for (const entry of expected) {
    const asset = gpuRuntimeAssets(target, entry.backend).find(asset => asset.id === entry.id)!
    assert.ok(asset)
    assert.equal(asset.url, `https://github.com/JavdexLabs/javdex-runtime/releases/download/llama-b11435-linux-gpu-r1/${entry.name}`)
    assert.equal(asset.bytes, entry.bytes); assert.equal(asset.sha256, entry.sha256)
    assert.equal(asset.filename, entry.name); assert.equal(asset.archivePrefix, entry.prefix)
    assert.equal(modelDownloadFile('store', asset), path.join('store', 'downloads', entry.sha256, `${entry.name}.part`))
  }
})
