import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAiRuntimeInstaller } from './runtimeInstaller'
import { AI_SUBTITLE_ASSETS, AI_MAC_BUNDLE_VERSION, aiRuntimeAssets, type AiRuntimeAsset } from './runtimeManifest'
import { runtimeTar } from './runtimeArchiveFixtures'

const contents = Buffer.from('model fixture data')
function asset(filename: string): AiRuntimeAsset {
  return { id: 'translation-model', label: 'Fixture', filename, bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'), url: 'https://model.invalid/fixture' }
}
function assets(filename: string): AiRuntimeAsset[] {
  return AI_SUBTITLE_ASSETS.map(item => item.id === 'translation-model' ? asset(filename) : item)
}
test('portable model installation verifies a resumed download and deleting one precision preserves other files and runtime tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-install-'))
  try {
    let requestedRange: string | undefined
    const download: typeof fetch = async (_url, options) => {
      requestedRange = new Headers(options?.headers).get('range') ?? undefined
      return new Response(contents.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${contents.length - 1}/${contents.length}` } })
    }
    const first = createAiRuntimeInstaller(root, download, assets('precision-A.gguf'))
    const filename = first.paths().translationModel
    await fs.mkdir(path.dirname(filename), { recursive: true })
    await fs.writeFile(`${filename}.part`, contents.subarray(0, 5))
    await first.install(new AbortController().signal, () => {}, ['translation-model'])
    assert.equal(requestedRange, 'bytes=5-')
    assert.deepEqual(await fs.readFile(filename), contents)
    assert.equal(await first.assetsInstalled(['translation-model']), true)
    const second = createAiRuntimeInstaller(root, async () => new Response(contents), assets('precision-B.gguf'))
    await second.install(new AbortController().signal, () => {}, ['translation-model'])
    const runtime = path.join(first.directory, 'translator', 'llama-server.exe')
    await fs.mkdir(path.dirname(runtime), { recursive: true }); await fs.writeFile(runtime, 'shared fixture')
    await first.removeAsset('translation-model')
    assert.equal(await first.assetsInstalled(['translation-model']), false)
    assert.equal(await second.assetsInstalled(['translation-model']), true)
    assert.equal(await fs.readFile(runtime, 'utf8'), 'shared fixture')
    assert.equal(await fs.access(`${filename}.part`).then(() => true, () => false), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('invalid hashes and mismatched resume ranges never publish a model as installed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-invalid-'))
  try {
    const installer = createAiRuntimeInstaller(root, async () => new Response(Buffer.alloc(contents.length)), assets('invalid.gguf'))
    await assert.rejects(installer.install(new AbortController().signal, () => {}, ['translation-model']), /完整性校验/)
    assert.equal(await installer.assetsInstalled(['translation-model']), false)
    assert.equal(await fs.access(`${installer.paths().translationModel}.part`).then(() => true, () => false), false)
    await fs.writeFile(`${installer.paths().translationModel}.part`, contents.subarray(0, 5))
    const badRange = createAiRuntimeInstaller(root, async () => new Response(contents.subarray(6), {
      status: 206, headers: { 'content-range': `bytes 6-${contents.length - 1}/${contents.length}` }
    }), assets('invalid.gguf'))
    await assert.rejects(badRange.install(new AbortController().signal, () => {}, ['translation-model']), /范围不匹配/)
    assert.equal(await badRange.assetsInstalled(['translation-model']), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('unsupported platforms can store weights but cannot install runtime tools', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-platform-'))
  try {
    let requests = 0
    const installer = createAiRuntimeInstaller(root, async () => { requests++; return new Response(contents) }, assets('portable.gguf'), { target: { platform: 'linux', arch: 'ia32' } })
    await installer.install(new AbortController().signal, () => {}, ['translation-model'])
    await assert.rejects(installer.install(new AbortController().signal, () => {}, ['translator']), /Windows x64/)
    assert.equal(await installer.installed(), false)
    assert.equal(requests, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('HY portable assets preserve family and cache identity, shared Qwen weights, and Tencent notices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-hy-'))
  try {
    const qwen = createAiRuntimeInstaller(root, async () => new Response(contents), assets('qwen-fixture.gguf'))
    await qwen.install(new AbortController().signal, () => {}, ['translation-model'])
    const hyAssets = assets('hy-fixture.gguf').map(item => item.id === 'translation-model' ? { ...item, translationModelId: 'hy-mt2-7b' as const } : item)
    const hy = createAiRuntimeInstaller(root, async () => new Response(contents), hyAssets)
    await hy.install(new AbortController().signal, () => {}, ['translation-model'])
    assert.equal(hy.paths().translationModelId, 'hy-mt2-7b')
    assert.notEqual(hy.paths().translationVersion, qwen.paths().translationVersion)
    assert.match(hy.paths().translationVersion!, /^hy-mt2-7b-llama-b11435-prompt-v1:/)
    assert.match(await fs.readFile(path.join(hy.directory, 'Hy-MT2-NOTICE.txt'), 'utf8'), /Copyright \(C\) 2026 Tencent/)
    assert.match(await fs.readFile(path.join(hy.directory, 'Apache-2.0.txt'), 'utf8'), /Apache License/)
    await hy.removeAsset('translation-model')
    assert.equal(await qwen.assetsInstalled(['translation-model']), true)
    assert.equal(await hy.assetsInstalled(['translation-model']), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('Index portable assets preserve family identity, separate weights and the official project license source', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-index-'))
  try {
    const qwen = createAiRuntimeInstaller(root, async () => new Response(contents), assets('qwen-fixture.gguf'))
    await qwen.install(new AbortController().signal, () => {}, ['translation-model'])
    const indexAssets = assets('index-fixture.gguf').map(item => item.id === 'translation-model' ? { ...item, translationModelId: 'index-translate-9b' as const } : item)
    const index = createAiRuntimeInstaller(root, async () => new Response(contents), indexAssets)
    await index.install(new AbortController().signal, () => {}, ['translation-model'])
    assert.equal(index.paths().translationModelId, 'index-translate-9b')
    assert.notEqual(index.paths().translationVersion, qwen.paths().translationVersion)
    assert.match(index.paths().translationVersion!, /^index-translate-9b-llama-b11435-prompt-v1:/)
    const notice = await fs.readFile(path.join(index.directory, 'Index-Translate-NOTICE.txt'), 'utf8')
    assert.match(notice, /Apache-2.0 declared by the official model card/)
    assert.match(notice, /https:\/\/huggingface.co\/IndexTeam\/Index-Translate-9B-GGUF/)
    assert.match(notice, /bilibili\/Index-Translate\/blob\/[a-f0-9]{40}\/LICENSE/)
    assert.match(await fs.readFile(path.join(index.directory, 'Apache-2.0.txt'), 'utf8'), /Apache License/)
    await index.removeAsset('translation-model')
    assert.equal(await qwen.assetsInstalled(['translation-model']), true)
    assert.equal(await index.assetsInstalled(['translation-model']), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('native archive installs validate inventories, repair missing libraries, and preserve old tools on failed replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-install-'))
  const target = { platform: 'linux', arch: 'arm64' }
  try {
    const packed = runtimeTar([{ path: 'release/llama-server', contents: 'native tool' }, { path: 'release/libfixture.so.1', contents: 'native library' },
      { path: 'release/libfixture.so', type: 'SymbolicLink', linkpath: 'libfixture.so.1' }])
    const nativeAsset: AiRuntimeAsset = { id: 'translator', label: 'Fixture runtime', archive: true, archivePrefix: 'release', filename: 'fixture.tar.gz',
      bytes: packed.length, sha256: createHash('sha256').update(packed).digest('hex'), url: 'https://runtime.invalid/fixture' }
    const manifest = [...aiRuntimeAssets(target).filter(asset => asset.id !== 'translator'), nativeAsset]
    let requests = 0
    const installer = createAiRuntimeInstaller(root, async () => { requests++; return new Response(packed) }, manifest, { target })
    await installer.install(new AbortController().signal, () => {}, ['translator'])
    assert.equal(await installer.assetsInstalled(['translator']), true)
    assert.equal(await installer.assetsInstalled(['not-listed' as AiRuntimeAsset['id']]), false)
    const tool = installer.paths().translator, library = path.join(path.dirname(tool), 'libfixture.so')
    assert.equal((await fs.lstat(library)).isSymbolicLink(), false)
    await installer.install(new AbortController().signal, () => {}, ['translator'])
    assert.equal(requests, 1)
    await fs.rm(library)
    assert.equal(await installer.assetsInstalled(['translator']), false)
    await installer.install(new AbortController().signal, () => {}, ['translator'])
    assert.equal(requests, 2)
    assert.equal(await installer.assetsInstalled(['translator']), true)
    const bad = runtimeTar([{ path: 'release/../llama-server', contents: 'malicious replacement' }])
    const replacement = createAiRuntimeInstaller(root, async () => new Response(bad), manifest.map(asset => asset.id === 'translator'
      ? { ...asset, bytes: bad.length, sha256: createHash('sha256').update(bad).digest('hex') } : asset), { target })
    await assert.rejects(replacement.install(new AbortController().signal, () => {}, ['translator']))
    assert.equal(await fs.readFile(tool, 'utf8'), 'native tool')
    assert.equal(await installer.assetsInstalled(['translator']), true)
    if (process.platform !== 'win32') {
      await fs.chmod(tool, 0o644)
      assert.equal(await installer.assetsInstalled(['translator']), false)
      await installer.install(new AbortController().signal, () => {}, ['translator'])
      assert.equal(await installer.assetsInstalled(['translator']), true)
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('macOS copies only the matching bundled tool, rejects damaged bundles and never downloads Windows executables', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-bundle-'))
  const target = { platform: 'darwin', arch: 'arm64' }
  try {
    const bundleRoot = path.join(root, 'bundle'), bundle = path.join(bundleRoot, 'darwin-arm64'), source = path.join(bundle, 'whisper', 'whisper-cli')
    await fs.mkdir(path.dirname(source), { recursive: true }); await fs.writeFile(source, contents)
    const inventory = { version: AI_MAC_BUNDLE_VERSION, target: 'darwin-arm64', assets: { whisper: { files: [{ name: 'whisper-cli', bytes: contents.length, sha256: asset('unused').sha256 }] } } }
    await fs.writeFile(path.join(bundle, 'bundle.json'), JSON.stringify(inventory))
    let requests = 0
    const installer = createAiRuntimeInstaller(root, async () => { requests++; throw new Error('Unexpected download') }, undefined, { target, bundleRoot })
    assert.equal(await installer.assetsInstalled(['whisper']), false)
    await installer.install(new AbortController().signal, () => {}, ['whisper'])
    assert.equal(await installer.assetsInstalled(['whisper']), true)
    assert.equal(requests, 0)
    await installer.removeAsset('whisper')
    await fs.writeFile(source, Buffer.alloc(contents.length))
    await assert.rejects(installer.install(new AbortController().signal, () => {}, ['whisper']), /完整性校验/)
    assert.equal(await installer.assetsInstalled(['whisper']), false)
    const intel = createAiRuntimeInstaller(root, undefined, undefined, { target: { platform: 'darwin', arch: 'x64' }, bundleRoot })
    assert.equal(await intel.assetsInstalled(['whisper']), false)
    await assert.rejects(intel.install(new AbortController().signal, () => {}, ['whisper']), /缺少 macOS/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
