import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { createAiRuntimeInstaller, type RuntimeInstallEvent } from './runtimeInstaller'
import { LOCAL_MODEL_ASSETS, aiRuntimeAssets, type AiRuntimeAsset } from './runtimeManifest'
import { modelAssetDirectory, modelDownloadFile, runtimeAssetDirectory } from './modelStorage'
import { runtimeTar } from './runtimeArchiveFixtures'
import { gpuRuntimeAssets } from './gpuManifest'

const contents = Buffer.from('model fixture data')
function asset(filename: string): AiRuntimeAsset {
  return { ...LOCAL_MODEL_ASSETS.find(item => item.id === 'translation-model')!,
    model: { ...LOCAL_MODEL_ASSETS.find(item => item.id === 'translation-model')!.model!, precision: filename.replace('.gguf', '') }, id: 'translation-model', label: 'Fixture', filename, bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'), url: 'https://model.invalid/fixture' }
}
function assets(filename: string): AiRuntimeAsset[] {
  return LOCAL_MODEL_ASSETS.map(item => item.id === 'translation-model' ? asset(filename) : item)
}

test('inventory rejects file ancestors instead of treating their missing descendants as uninstalled', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-inventory-ancestor-'))
  const entry = asset('ancestor.gguf')
  const originalLstat = fs.lstat
  let obstruction = ''
  const mocked = t.mock.method(fs, 'lstat', (async (...args: Parameters<typeof fs.lstat>) => {
    try { return await originalLstat(...args) }
    catch (cause) {
      // Reproduce Windows' ENOENT for descendants of a regular file on any host.
      if ((cause as NodeJS.ErrnoException).code === 'ENOTDIR' && String(args[0]).startsWith(`${obstruction}${path.sep}`)) {
        throw Object.assign(new Error('Missing descendant of an obstructing file'), { code: 'ENOENT' })
      }
      throw cause
    }
  }) as typeof fs.lstat)
  try {
    const missing = path.join(parent, 'absent')
    assert.equal(await createAiRuntimeInstaller(missing, undefined, assets('ancestor.gguf')).assetPresent('translation-model'), false)
    await assert.rejects(fs.access(missing), { code: 'ENOENT' }, 'inventory must not create a missing store')
    for (const branch of ['models', 'downloads'] as const) {
      const sample = branch === 'models' ? modelAssetDirectory(parent, entry) : path.dirname(modelDownloadFile(parent, entry))
      const parts = path.relative(parent, sample).split(path.sep)
      for (let depth = 0; depth <= parts.length; depth++) {
        const root = path.join(parent, `${branch}-${depth}`)
        obstruction = path.join(root, ...parts.slice(0, depth))
        await fs.mkdir(path.dirname(obstruction), { recursive: true })
        await fs.writeFile(obstruction, 'preserved obstruction')
        const runtime = createAiRuntimeInstaller(root, undefined, assets('ancestor.gguf'))
        await assert.rejects(runtime.assetPresent('translation-model'), /模型目录/, `${branch} ancestor ${depth}`)
        assert.equal(await fs.readFile(obstruction, 'utf8'), 'preserved obstruction')
      }
    }
    const valid = path.join(parent, 'valid')
    const directory = modelAssetDirectory(valid, entry)
    await fs.mkdir(directory, { recursive: true })
    const runtime = createAiRuntimeInstaller(valid, undefined, assets('ancestor.gguf'))
    assert.equal(await runtime.assetPresent('translation-model'), false)
    await fs.writeFile(path.join(directory, 'partial.gguf'), 'partial')
    assert.equal(await runtime.assetPresent('translation-model'), true)
  } finally { mocked.mock.restore(); await fs.rm(parent, { recursive: true, force: true }) }
})

test('removing a runtime deletes damaged files and archive resume data while preserving other backends and external paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-delete-'))
  const target = { platform: 'win32', arch: 'x64' }
  const entry = aiRuntimeAssets(target).find(item => item.id === 'translator')!
  const destination = runtimeAssetDirectory(root, 'translator', target)
  const other = runtimeAssetDirectory(root, 'translator', target, 'cuda')
  const partial = modelDownloadFile(root, entry)
  const external = path.join(root, 'external')
  try {
    const runtime = createAiRuntimeInstaller(root, undefined, [entry], { target })
    assert.equal(await runtime.assetPresent('translator'), false)
    await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, 'damaged.dll'), 'broken')
    await fs.mkdir(other, { recursive: true }); await fs.writeFile(path.join(other, 'keep.dll'), 'gpu')
    await fs.mkdir(external); await fs.writeFile(path.join(external, 'keep'), 'outside')
    await fs.mkdir(path.dirname(partial), { recursive: true }); await fs.writeFile(partial, 'partial archive')
    assert.equal(await runtime.assetsInstalled(['translator']), false)
    assert.equal(await runtime.assetPresent('translator'), true)
    await runtime.removeAsset('translator')
    assert.equal(await runtime.assetPresent('translator'), false)
    assert.equal(await fs.readFile(path.join(other, 'keep.dll'), 'utf8'), 'gpu')
    await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, 'keep.dll'), 'cpu')
    await fs.symlink(external, path.dirname(partial), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(runtime.removeAsset('translator'), /链接/)
    assert.equal(await fs.readFile(path.join(destination, 'keep.dll'), 'utf8'), 'cpu')
    assert.equal(await fs.readFile(path.join(external, 'keep'), 'utf8'), 'outside')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('preparation events report new network bytes separately from resumed and reused contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-events-'))
  const entry = asset('events.gguf'), events: RuntimeInstallEvent[] = []
  let requests = 0
  try {
    const runtime = createAiRuntimeInstaller(root, async () => {
      requests++
      return new Response(contents.subarray(5), { status: 206, headers: { 'content-range': `bytes 5-${contents.length - 1}/${contents.length}` } })
    }, assets('events.gguf'))
    await fs.mkdir(path.dirname(modelDownloadFile(root, entry)), { recursive: true })
    await fs.writeFile(modelDownloadFile(root, entry), contents.subarray(0, 5))
    await runtime.install(new AbortController().signal, () => {}, ['translation-model'], event => events.push(event))
    assert.equal(events.at(-1)?.networkBytes, contents.length - 5)
    assert.equal(events.at(-1)?.networkTotal, contents.length - 5)
    assert.ok(events.some(event => event.phase === 'installing'))
    events.length = 0
    await runtime.install(new AbortController().signal, () => {}, ['translation-model'], event => events.push(event))
    assert.equal(requests, 1)
    assert.equal(events.at(-1)?.phase, 'reused')
    assert.equal(events.at(-1)?.networkBytes, 0)
    assert.equal(events.at(-1)?.networkTotal, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
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
    await fs.mkdir(path.dirname(modelDownloadFile(root, asset('precision-A.gguf'))), { recursive: true })
    await fs.writeFile(modelDownloadFile(root, asset('precision-A.gguf')), contents.subarray(0, 5))
    await first.install(new AbortController().signal, () => {}, ['translation-model'])
    assert.equal(requestedRange, 'bytes=5-')
    assert.deepEqual(await fs.readFile(filename), contents)
    assert.equal(await first.assetsInstalled(['translation-model']), true)
    const second = createAiRuntimeInstaller(root, async () => new Response(contents), assets('precision-B.gguf'))
    await second.install(new AbortController().signal, () => {}, ['translation-model'])
    const runtime = first.paths().translator
    await fs.mkdir(path.dirname(runtime), { recursive: true }); await fs.writeFile(runtime, 'shared fixture')
    await first.removeAsset('translation-model')
    assert.equal(await first.assetsInstalled(['translation-model']), false)
    assert.equal(await second.assetsInstalled(['translation-model']), true)
    assert.equal(await fs.readFile(runtime, 'utf8'), 'shared fixture')
    assert.equal(await fs.access(modelDownloadFile(root, asset('precision-A.gguf'))).then(() => true, () => false), false)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('invalid hashes and mismatched resume ranges never publish a model as installed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-model-invalid-'))
  try {
    const installer = createAiRuntimeInstaller(root, async () => new Response(Buffer.alloc(contents.length)), assets('invalid.gguf'))
    await assert.rejects(installer.install(new AbortController().signal, () => {}, ['translation-model']), /完整性校验/)
    assert.equal(await installer.assetsInstalled(['translation-model']), false)
    assert.equal(await fs.access(modelDownloadFile(root, asset('invalid.gguf'))).then(() => true, () => false), false)
    await fs.writeFile(modelDownloadFile(root, asset('invalid.gguf')), contents.subarray(0, 5))
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
    const hyAssets = assets('hy-fixture.gguf').map(item => item.id === 'translation-model' ? { ...item, model: { ...item.model!, family: 'hy-mt2-7b', publisher: 'tencent' }, translationModelId: 'hy-mt2-7b' as const } : item)
    const hy = createAiRuntimeInstaller(root, async () => new Response(contents), hyAssets)
    await hy.install(new AbortController().signal, () => {}, ['translation-model'])
    assert.equal(hy.paths().translationModelId, 'hy-mt2-7b')
    assert.notEqual(hy.paths().translationVersion, qwen.paths().translationVersion)
    assert.match(hy.paths().translationVersion!, /^hy-mt2-7b-llama-b11435-prompt-v1:/)
    assert.match(await fs.readFile(path.join(path.dirname(hy.paths().translationModel), 'NOTICE.txt'), 'utf8'), /Copyright \(C\) 2026 Tencent/)
    assert.match(await fs.readFile(path.join(path.dirname(hy.paths().translationModel), 'LICENSE.txt'), 'utf8'), /Apache License/)
    await hy.removeAsset('translation-model')
    assert.equal(await qwen.assetsInstalled(['translation-model']), true)
    assert.equal(await hy.assetsInstalled(['translation-model']), false)
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

test('macOS downloads and verifies its own native archive without an application bundle', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-mac-download-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const target = { platform: 'darwin', arch: 'arm64' }
  const packed = runtimeTar([{ path: 'mac-arm64/whisper-cli', contents: 'native whisper' }, { path: 'mac-arm64/LICENSE', contents: 'MIT' }])
  const nativeAsset: AiRuntimeAsset = { id: 'whisper', label: '语音引擎', archive: true, filename: 'whisper.tar.gz', archivePrefix: 'mac-arm64',
    bytes: packed.length, sha256: createHash('sha256').update(packed).digest('hex'), url: 'https://example.invalid/mac-arm64.tar.gz' }
  const manifest = [...aiRuntimeAssets(target).filter(asset => asset.id !== 'whisper'), nativeAsset]
  let requests = 0
  const installer = createAiRuntimeInstaller(root, async input => { assert.equal(String(input), nativeAsset.url); requests++; return new Response(packed) }, manifest, { target })
  assert.equal(await installer.assetsInstalled(['whisper']), false)
  await installer.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(await installer.assetsInstalled(['whisper']), true)
  assert.equal(await fs.readFile(installer.paths().whisper, 'utf8'), 'native whisper')
  await installer.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(requests, 1)
  const changed = createAiRuntimeInstaller(root, async () => new Response(Buffer.alloc(packed.length)), manifest, { target })
  await changed.removeAsset('whisper')
  await assert.rejects(changed.install(new AbortController().signal, () => {}, ['whisper']), /完整性校验/)
  assert.equal(await changed.assetsInstalled(['whisper']), false)
})

test('installed Linux llama GPU tools survive the mirror move without downloading or rewriting', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-linux-llama-mirror-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const target = { platform: 'linux', arch: 'x64' }
  for (const backend of ['cuda', 'vulkan'] as const) {
    for (const entry of gpuRuntimeAssets(target, backend).filter(asset => asset.id === 'translator' || asset.id === 'cuda')) {
      const directory = runtimeAssetDirectory(root, entry.id, target, backend)
      await fs.mkdir(directory, { recursive: true })
      const names = entry.id === 'cuda' ? ['libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12'] : ['llama-server']
      if (backend === 'cuda') names.push('NOTICE-CUDA.txt')
      const files = []
      for (const name of names) {
        const value = Buffer.from(`installed fixture ${name}`)
        await fs.writeFile(path.join(directory, name), value, { mode: 0o755 })
        files.push({ name, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') })
      }
      const marker = JSON.stringify({ sha256: entry.sha256, target: 'linux-x64', files })
      await fs.writeFile(path.join(directory, 'asset.json'), marker)
      let requests = 0
      const runtime = createAiRuntimeInstaller(root, async () => { requests++; throw Error('unexpected download') }, [entry], { target })
      assert.equal(await runtime.assetsInstalled([entry.id]), true)
      await runtime.install(new AbortController().signal, () => {}, [entry.id])
      assert.equal(requests, 0)
      assert.equal(await fs.readFile(path.join(directory, 'asset.json'), 'utf8'), marker)
    }
  }
})

test('a valid previously installed Windows Vulkan tool survives the distribution move without downloading or rewriting', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-runtime-legacy-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const target = { platform: 'win32', arch: 'x64' }
  const entry: AiRuntimeAsset = { id: 'whisper', backend: 'vulkan', archive: true, label: 'Fixture', filename: 'whisper.zip',
    bytes: 100, sha256: 'e'.repeat(64), url: 'https://runtime.invalid/fixed.zip', expandedBytes: 1024 * 1024,
    runtimePackage: { version: 'whisper-b5130-r1', commit: 'a'.repeat(40), runId: 1234, upstreamCommit: '927cfce34f31707e17f2bff35c349632fb9e2c3a' },
    legacyInstalledIdentity: 'whisper-b5130-vulkan-v1:win32-x64:whisper' }
  const directory = runtimeAssetDirectory(root, 'whisper', target, 'vulkan')
  await fs.mkdir(directory, { recursive: true })
  const files = []
  for (const name of ['whisper-cli.exe', 'vulkan-1.dll', 'LICENSE.txt']) {
    const value = Buffer.from(`legacy fixture ${name}`)
    await fs.writeFile(path.join(directory, name), value)
    files.push({ name, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') })
  }
  const marker = JSON.stringify({ sha256: entry.legacyInstalledIdentity, target: 'win32-x64', files })
  await fs.writeFile(path.join(directory, 'asset.json'), marker)
  let requests = 0
  const runtime = createAiRuntimeInstaller(root, async () => { requests++; throw Error('fixture download failure') }, [entry], { target })
  assert.equal(await runtime.assetsInstalled(['whisper']), true)
  await runtime.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(requests, 0)
  assert.equal(await fs.readFile(path.join(directory, 'asset.json'), 'utf8'), marker)
  await fs.appendFile(path.join(directory, 'vulkan-1.dll'), 'corrupt')
  assert.equal(await runtime.assetsInstalled(['whisper']), false)
  await assert.rejects(runtime.install(new AbortController().signal, () => {}, ['whisper']), /fixture download failure/)
  assert.equal(await fs.readFile(path.join(directory, 'whisper-cli.exe'), 'utf8'), 'legacy fixture whisper-cli.exe')
})

test('verified existing macOS Whisper survives download delivery but same-size mutations require repair', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'javdex-mac-legacy-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const target = { platform: 'darwin', arch: 'arm64' }
  const legacy = 'whisper-b5130-ffmpeg-8.1.3-v1:darwin-arm64:whisper'
  const packed = runtimeTar([{ path: 'mac/whisper-cli', contents: 'new engine' }])
  const entry: AiRuntimeAsset = { id: 'whisper', label: '语音引擎', filename: 'mac.tar.gz', archive: true, archivePrefix: 'mac',
    bytes: packed.length, sha256: createHash('sha256').update(packed).digest('hex'), url: 'https://github.com/JavdexLabs/javdex-runtime/releases/download/whisper-b5130-r2/whisper-b5130-r2-darwin-arm64.tar.gz', legacyInstalledIdentity: legacy }
  const base = runtimeAssetDirectory(root, 'whisper', target), file = path.join(base, 'whisper-cli')
  await fs.mkdir(base, { recursive: true }); await fs.writeFile(file, contents, { mode: 0o755 })
  const marker = JSON.stringify({ sha256: legacy, target: 'darwin-arm64', files: [{ name: 'whisper-cli', bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') }] })
  await fs.writeFile(path.join(base, 'asset.json'), marker)
  let requests = 0
  const manager = createAiRuntimeInstaller(root, async () => { requests++; return new Response(packed) }, [...aiRuntimeAssets(target).filter(a => a.id !== 'whisper'), entry], { target })
  assert.equal(await manager.assetsInstalled(['whisper']), true)
  await manager.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(requests, 0); assert.equal(await fs.readFile(path.join(base, 'asset.json'), 'utf8'), marker)
  await fs.writeFile(file, Buffer.alloc(contents.length), { mode: 0o755 })
  assert.equal(await manager.assetsInstalled(['whisper']), false)
  await manager.install(new AbortController().signal, () => {}, ['whisper'])
  assert.equal(requests, 1); assert.equal(await fs.readFile(file, 'utf8'), 'new engine')
})
