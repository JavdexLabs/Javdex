import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { aiRuntimeAssets, aiRuntimeTargetSupported, LOCAL_MODEL_ASSETS } from './runtimeManifest'
import { createAiRuntimeInstaller, aiRuntimeHostSupported } from './runtimeInstaller'
import { localModelAssets, DEFAULT_LOCAL_MODEL_VARIANTS } from './modelCatalog'
import { runtimeAssetDirectory } from './modelStorage'
import { gpuRuntimeAssets } from './gpuManifest'
import pins from './runtimeDistributions.json'

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

test('all AI tools and VAD pin managed releases and each target includes downloadable speech tools', () => {
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
      assert.ok(pin.target === 'portable' || pin.target === `${target.platform}-${target.arch}`)
      if (asset.archive && target.platform !== 'win32') assert.equal(asset.archivePrefix, pin.archivePrefix)
    }
    const ffmpeg = base.find(asset => asset.id === 'ffmpeg')!
    const storage = runtimeAssetDirectory('store', 'ffmpeg', target)
    assert.equal(path.basename(path.dirname(storage)), '8.1.3-r1')
    assert.ok(ffmpeg.url.includes('/ffmpeg-8.1.3-r1/'))
  }
})
